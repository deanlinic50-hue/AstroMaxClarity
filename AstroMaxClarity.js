// ============================================================
//  AstroMaxClarity.js  v2.0.0
//  Copyright (C) 2026 Dean Linic
//
//  Lightroom-style image processing script for PixInsight.
//
//  Features:
//    Clarity   — Local contrast enhancement by tone zone
//                (Shadows / Midtones / Highlights independently)
//                Positive values enhance microcontrast,
//                negative values soften local contrast.
//    Lum Sharp — Luminance-only sharpening (colour-neutral)
//                Uses L-channel ratio method: sharpens structure
//                without introducing colour fringing.
//
//  Controls:
//    Sliders update the value display instantly.
//    Preview refreshes when you release the slider.
//    Drag on preview canvas to zoom into any area (2x/4x/8x).
//
//  Requirements:
//    PixInsight 1.8.9 or later
//
//  Installation:
//    Copy AstroMaxClarity.js to:
//      <PixInsight>/src/scripts/  (global install)
//    or use Script > Feature Scripts > Add to load from any path.
//    Then run via: Script > Utilities > AstroMaxClarity
//
//  Changelog:
//    v3.0.0 — Dual image selector (Starless+Stars). Star blend via direct Image API.
//    v2.0.0 — Stable release. Removed NR (requires external plugin).
//             Clarity via MultiscaleLinearTransform LCE.
//             Luminance sharpening via L-ratio method.
//             Bilinear zoom rendering. Slider-release refresh.
//    v1.x   — Development iterations.
// ============================================================

#feature-id    Utilities > AstroMaxClarity
#feature-info  Tone-zone clarity and luminance sharpening for PixInsight.<br/>\
               Copyright &copy; 2026 Dean Linic

var AMC_VERSION = "3.6.0";

// ============================================================
//  HIDDEN WINDOW POOL
// ============================================================
var WIN = {};

function getWin(id, refImg, gray) {
   var nc=gray?1:refImg.numberOfChannels;
   var w=refImg.width, h=refImg.height;
   var ex=WIN[id];
   if(ex&&!ex.isNull){
      var ei=ex.mainView.image;
      if(ei.width===w&&ei.height===h&&ei.numberOfChannels===nc) return ex;
      ex.forceClose();
   }
   var nw=new ImageWindow(w,h,nc,refImg.bitsPerSample,refImg.isReal,nc>1,id);
   nw.hide(); WIN[id]=nw; return nw;
}

function closeAllWins(){
   for(var k in WIN){if(WIN[k]&&!WIN[k].isNull)WIN[k].forceClose();}
   WIN={};
}

function setWin(win,img){
   win.mainView.beginProcess(0);
   win.mainView.image.assign(img);
   win.mainView.endProcess();
}

function getImg(win){
   var i=win.mainView.image;
   var d=new Image(i.width,i.height,i.numberOfChannels,i.colorSpace,i.bitsPerSample,i.sampleType);
   d.assign(i); return d;
}

function copyWin(dst,src){
   dst.mainView.beginProcess(0);
   dst.mainView.image.assign(src.mainView.image);
   dst.mainView.endProcess();
}

// ============================================================
//  IMAGE UTILITIES
// ============================================================
function cloneImg(src){
   // new Image(src) = PJSR copy constructor — guaranteed pixel copy
   return new Image(src);
}

function scaleImage(img,f){
   var out=new Image(img);
   out.resample(f);
   return out;
}

// Resize to EXACT pixel dimensions — no rounding mismatch
function resizeTo(img, w, h){
   var out=new Image(img);
   if(out.width!==w||out.height!==h)
      out.resizeTo(w, h, 1);   // 1=bilinear
   return out;
}

// ============================================================
//  PIXELMATH HELPERS
// ============================================================
function pmSelf(view,expr){
   var pm=new PixelMath;
   pm.expression=expr; pm.useSingleExpression=true;
   pm.rescale=false; pm.truncate=true; pm.createNewImage=false;
   pm.executeOn(view);
}

function pmCross(dstView,expr){
   var pm=new PixelMath;
   pm.expression=expr; pm.useSingleExpression=true;
   pm.rescale=false; pm.truncate=true; pm.createNewImage=false;
   pm.executeOn(dstView);
}

function buildLum(srcWin,lumWin){
   var sid=srcWin.mainView.id, nc=srcWin.mainView.image.numberOfChannels;
   if(nc===1){copyWin(lumWin,srcWin);return;}
   pmCross(lumWin.mainView,"0.2126*"+sid+"[0]+0.7152*"+sid+"[1]+0.0722*"+sid+"[2]");
}

function buildZone(lumWin,center,halfWidth){
   var hw=Math.max(0.01,halfWidth).toFixed(6), ctr=center.toFixed(6);
   var t="max(0,min(1,(1-abs($T-"+ctr+")/"+hw+")))";
   pmSelf(lumWin.mainView,t+"*"+t+"*(3-2*"+t+")");
}

function scaleMask(maskWin,factor){
   pmSelf(maskWin.mainView,"$T*"+factor.toFixed(6));
}

function applyUSM(win,sigma,amount,threshold){
   var u=new UnsharpMask;
   u.sigma=Math.max(0.1,sigma);
   u.amount=Math.max(0.001,Math.min(1.0,amount));
   u.threshold=Math.max(0,Math.min(1,threshold));
   u.executeOn(win.mainView);
}

// ============================================================
//  CLARITY — Lightroom accurate
//
//  Lightroom Clarity = large-radius local contrast enhancement
//  specifically targeting midtones.
//
//  Algorithm:
//  1. Create blurred version (large sigma = local mean / low-freq)
//  2. High-pass detail = original - blurred
//  3. Build midtone luminance mask (bell centred at 0.5)
//  4. out = original + mask * strength * detail
//
//  This is what Lightroom does: it enhances contrast around
//  edges at a macro scale, making structures "pop".
//  Sigma ~25-40px (at full res) = macro contrast.
//  We scale sigma by image width/1000 to stay consistent.
//
//  Per-zone variant: same method but mask centred at zone value.
// ============================================================
function applyClarity(baseWin, blurWin, shpWin, lumWin, maskWin,
                       center, clarityVal, zoneWidth, sigma) {
   if(Math.abs(clarityVal)<0.5) return;

   // Large-sigma blur = local mean (Lightroom uses ~25px at 1000px wide)
   // We use MLT with only the residual (course scales) for speed
   copyWin(blurWin, baseWin);
   var mlt=new MultiscaleLinearTransform;
   // Keep only scales 4-5 (coarse structure), discard fine detail
   // This gives us the local mean / low frequency component
   mlt.layers=[
      [false,true,0.000,false,3.0,1.0,1],  // scale 1 — discard
      [false,true,0.000,false,3.0,1.0,1],  // scale 2 — discard
      [false,true,0.000,false,3.0,1.0,1],  // scale 3 — discard
      [true, true,0.000,false,3.0,1.0,1],  // scale 4 — keep
      [true, true,0.000,false,3.0,1.0,1]   // residual — keep
   ];
   mlt.transform=MultiscaleLinearTransform.prototype.StarletTransform;
   mlt.executeOn(blurWin.mainView);
   // blurWin now holds low-frequency (blurred) version

   // Zone mask: luminance bell around center
   buildLum(baseWin, lumWin);
   buildZone(lumWin, center, zoneWidth/200.0);
   copyWin(maskWin, lumWin);
   if(clarityVal<0) scaleMask(maskWin, Math.abs(clarityVal)/100.0);

   // Detail = base - blur (high-pass)
   // Blend: base + mask * strength * (base - blur)
   var bi=baseWin.mainView.id;
   var bl=blurWin.mainView.id;
   var mk=maskWin.mainView.id;
   var str=(Math.abs(clarityVal)/100.0*2.0).toFixed(6);

   if(clarityVal>0){
      // Positive: enhance local contrast (add high-pass scaled by mask)
      pmCross(baseWin.mainView, "min(1,max(0,"+bi+"+"+mk+"*"+str+"*("+bi+"-"+bl+")))");
   } else {
      // Negative: reduce local contrast (subtract high-pass = flatten)
      pmCross(baseWin.mainView, "min(1,max(0,"+bi+"-"+mk+"*"+str+"*("+bi+"-"+bl+")))");
   }
}

// ============================================================
//  LUMINANCE SHARPENING — L channel ratio, no colour shift
// ============================================================
function applyLumSharpening(baseWin,shpWin,lumWin,sigma,amount,threshold){
   if(amount<0.5) return;
   var nc=baseWin.mainView.image.numberOfChannels;
   copyWin(shpWin,baseWin);
   applyUSM(shpWin,sigma,amount/100.0*0.9,threshold/100.0);
   if(nc===1){ copyWin(baseWin,shpWin); return; }
   // Colour preservation: multiply base by lumSharp/lumOrig
   buildLum(baseWin,lumWin);
   var lumOrig=getWin("_amc_lumo_",baseWin.mainView.image,true);
   copyWin(lumOrig,lumWin);
   buildLum(shpWin,lumWin);
   var bi=baseWin.mainView.id,lo=lumOrig.mainView.id,ls=lumWin.mainView.id;
   pmCross(baseWin.mainView,"min(1,"+bi+"*min(2.0,("+ls+"+1e-7)/("+lo+"+1e-7)))");
}

// ============================================================
//  MAIN PROCESS PIPELINE
// ============================================================
function processImage(src,p){
   var noOp=(Math.abs(p.clarityS)<0.5&&Math.abs(p.clarityM)<0.5&&
             Math.abs(p.clarityH)<0.5&&p.lumSharpAmount<0.5);

   if(noOp) return cloneImg(src);

   var baseWin=getWin("_amc_base_",src,false);
   var shpWin =getWin("_amc_shp_", src,false);
   var blurWin=getWin("_amc_blur_",src,false);
   var lumWin =getWin("_amc_lum_", src,true);
   var maskWin=getWin("_amc_mask_",src,true);

   setWin(baseWin,src);

   // Clarity zones
   applyClarity(baseWin,blurWin,shpWin,lumWin,maskWin, 0.20,p.clarityS,p.widthS,p.sigma);
   applyClarity(baseWin,blurWin,shpWin,lumWin,maskWin, 0.50,p.clarityM,p.widthM,p.sigma);
   applyClarity(baseWin,blurWin,shpWin,lumWin,maskWin, 0.80,p.clarityH,p.widthH,p.sigma);

   // Luminance sharpening last
   applyLumSharpening(baseWin,shpWin,lumWin,p.lumSharpSigma,p.lumSharpAmount,p.lumSharpThreshold);

   // Star recomposition (screen blend stars onto result)


   return getImg(baseWin);
}

// ============================================================
//  PREVIEW RENDERING
// ============================================================
function normParams(img){
   var med=img.median(),lo,range;
   if(med>0.05){lo=0;range=1.0;}
   else{
      var mad=img.MAD(); if(mad<1e-7)mad=0.001;
      var s=mad*1.4826; lo=Math.max(0,med-2.8*s);
      range=Math.min(1.0,med+20.0*s)-lo;
      if(range<0.0001)range=0.0001;
   }
   return{lo:lo,range:range};
}

function sampleBilinear(img,fx,fy,c){
   var w=img.width,h=img.height;
   var x0=Math.max(0,Math.min(w-2,Math.floor(fx)));
   var y0=Math.max(0,Math.min(h-2,Math.floor(fy)));
   var tx=fx-x0,ty=fy-y0;
   return img.sample(x0,y0,c)*(1-tx)*(1-ty)
         +img.sample(x0+1,y0,c)*tx*(1-ty)
         +img.sample(x0,y0+1,c)*(1-tx)*ty
         +img.sample(x0+1,y0+1,c)*tx*ty;
}

function toU8(v,lo,range){
   return Math.min(255,Math.max(0,Math.round((v-lo)/range*255)));
}

function renderFull(img,W,H){
   var scale=Math.min(W/img.width,H/img.height);
   var dw=Math.max(1,Math.round(img.width*scale));
   var dh=Math.max(1,Math.round(img.height*scale));
   var sc=scaleImage(img,scale);
   var n=normParams(img);
   var bmp=new Bitmap(dw,dh);
   var ch=sc.numberOfChannels;
   for(var y=0;y<dh;y++){
      for(var x=0;x<dw;x++){
         var r,g,b;
         if(ch===1){var v=Math.min(1,Math.max(0,(sc.sample(x,y,0)-n.lo)/n.range));r=g=b=Math.round(v*255);}
         else{r=toU8(sc.sample(x,y,0),n.lo,n.range);
              g=toU8(sc.sample(x,y,1),n.lo,n.range);
              b=toU8(sc.sample(x,y,2),n.lo,n.range);}
         bmp.setPixel(x,y,(0xFF<<24)|(r<<16)|(g<<8)|b);
      }
   }
   return bmp;
}

function renderZoom(img,cx,cy,level,W,H){
   var cw=1.0/level,ch=1.0/level;
   var x0=Math.max(0,Math.min(1-cw,cx-cw/2));
   var y0=Math.max(0,Math.min(1-ch,cy-ch/2));
   var sw=img.width,sh=img.height;
   var n=normParams(img);
   var bmp=new Bitmap(W,H);
   var ich=img.numberOfChannels;
   for(var py=0;py<H;py++){
      var fy=(y0+py/H*ch)*sh-0.5;
      for(var px=0;px<W;px++){
         var fx=(x0+px/W*cw)*sw-0.5;
         var r,g,b;
         if(ich===1){var v=Math.min(1,Math.max(0,(sampleBilinear(img,fx,fy,0)-n.lo)/n.range));r=g=b=Math.round(v*255);}
         else{r=toU8(sampleBilinear(img,fx,fy,0),n.lo,n.range);
              g=toU8(sampleBilinear(img,fx,fy,1),n.lo,n.range);
              b=toU8(sampleBilinear(img,fx,fy,2),n.lo,n.range);}
         bmp.setPixel(px,py,(0xFF<<24)|(r<<16)|(g<<8)|b);
      }
   }
   return bmp;
}


// ============================================================
//  STAR BLEND — screen blend with MTF control
//
//  Matches PixelMath formula: ~(~$T * ~mtf(m, Stars))
//
//  slider=0   → m=0.999 → stars invisible (MTF dims them)
//  slider=50  → m=0.500 → stars exactly as-is (identity)
//  slider=100 → m=0.001 → stars very bright
//
//  KEY: stars are read using NORMALIZED coordinates so they
//  always align correctly regardless of their resolution.
//  No pre-scaling of stars image needed.
//
//  MTF: lower m = brighter, higher m = darker (PI convention)
// ============================================================
function mtf(m, x) {
   if(x<=0) return 0;
   if(x>=1) return 1;
   if(Math.abs(m-0.5)<1e-6) return x;
   return (m-1)*x / ((2*m-1)*x - m);
}

function blendStarsOnImage(base, stars, sliderVal) {
   if(sliderVal < 0.1) return;
   // INVERTED: slider right = brighter = lower m
   var m = 0.999 - (sliderVal/100.0) * 0.998;
   var bw=base.width, bh=base.height, nc=base.numberOfChannels;
   var sw=stars.width, sh=stars.height, snc=stars.numberOfChannels;
   for(var c=0;c<nc;c++){
      var sc=Math.min(c,snc-1);
      for(var y=0;y<bh;y++){
         // Normalized coords → read from stars at proportional position
         // This works regardless of stars vs base resolution
         var sy=Math.min(sh-1, Math.round(y*(sh-1)/(bh-1)));
         for(var x=0;x<bw;x++){
            var sx=Math.min(sw-1, Math.round(x*(sw-1)/(bw-1)));
            var b=base.sample(x,y,c);
            var s=mtf(m, stars.sample(sx,sy,sc));
            base.setSample(1-(1-b)*(1-s), x, y, c);
         }
      }
   }
}

// ============================================================
//  DIALOG
// ============================================================
function AstroMaxClarityDialog(){
   this.__base__=Dialog;
   this.__base__();
   this.windowTitle="AstroMaxClarity v"+AMC_VERSION;
   this.userResizable=true;
   var self=this;

   var windows=ImageWindow.windows;
   this.imageWindows=[];
   for(var i=0;i<windows.length;i++){
      var w=windows[i];
      if(!w.isNull&&!w.mainView.isNull
         &&w.mainView.id.indexOf("_amc_")<0
         &&w.mainView.id.indexOf("AstroMax")<0)
         this.imageWindows.push(w);
   }
   if(this.imageWindows.length===0){this.srcView=null;return;}

   // Starless image (main)
   this.starlessWin    = this.imageWindows[0];
   this.starlessOrig   = cloneImg(this.starlessWin.mainView.image);
   // Stars image (optional second selection)
   this.starsOrig      = null;
   this.starsPreview   = null;

   // Keep srcWin/srcView/origImg aliases for processImage compatibility
   this.srcWin  = this.starlessWin;
   this.srcView = this.starlessWin.mainView;
   this.origImg = this.starlessOrig;

   this.busy=false;
   this.needsRefresh=false;

   var SCALE=0.25;
   this.SCALE=SCALE;
   this.previewImg=scaleImage(this.starlessOrig,SCALE);

   this.p={
      clarityS:0,widthS:40,
      clarityM:0,widthM:50,
      clarityH:0,widthH:40,
      sigma:5.0,
      lumSharpAmount:0,lumSharpSigma:1.5,lumSharpThreshold:5,
      starsBlend:0
   };

   this.lastRes=null;
   this.previewBitmap=null;
   this.zoomMode=false;
   this.zoomCX=0.5;this.zoomCY=0.5;
   this.zoomLevel=4;
   this.dragStart=null;this.dragRect=null;

   var PW=700;
   var PH=Math.round(PW*this.origImg.height/this.origImg.width);
   if(PH>560){PH=560;PW=Math.round(PH*this.origImg.width/this.origImg.height);}
   this.PW=PW;this.PH=PH;

   this.canvas=new Control(this);
   this.canvas.setFixedSize(PW,PH);

   this.canvas.onPaint=function(){
      var g=new VectorGraphics(self.canvas);
      var cw=self.canvas.width,ch=self.canvas.height;
      g.fillRect(0,0,cw,ch,new Brush(0xFF111111));
      if(self.previewBitmap!==null){
         var bw=self.previewBitmap.width,bh=self.previewBitmap.height;
         var ox=Math.max(0,Math.round((cw-bw)/2));
         var oy=Math.max(0,Math.round((ch-bh)/2));
         g.drawBitmap(ox,oy,self.previewBitmap);
         if(!self.zoomMode&&self.dragRect!==null){
            g.pen=new Pen(0xFFFFFF00,1);
            g.drawRect(self.dragRect.x,self.dragRect.y,
                       self.dragRect.x+self.dragRect.w,self.dragRect.y+self.dragRect.h);
         }
         if(self.zoomMode){
            g.pen=new Pen(0xFFFFFF88,1);
            g.drawText(8,18,"Zoom "+self.zoomLevel+"x  \u2014  click 'Reset Zoom' to go back");
         }
      }
      g.end();
   };

   this.canvas.onMousePress=function(x,y,btn){
      if(self.zoomMode)return;
      self.dragStart={x:x,y:y};self.dragRect=null;
   };
   this.canvas.onMouseMove=function(x,y,btn){
      if(self.dragStart===null||self.zoomMode)return;
      self.dragRect={x:Math.min(self.dragStart.x,x),y:Math.min(self.dragStart.y,y),
                     w:Math.abs(x-self.dragStart.x),h:Math.abs(y-self.dragStart.y)};
      self.canvas.repaint();
   };
   this.canvas.onMouseRelease=function(x,y,btn){
      if(self.zoomMode||self.dragStart===null)return;
      if(self.dragRect!==null&&self.dragRect.w>15&&self.dragRect.h>15&&self.previewBitmap!==null){
         var bw=self.previewBitmap.width,bh=self.previewBitmap.height;
         var ox=Math.max(0,Math.round((self.PW-bw)/2));
         var oy=Math.max(0,Math.round((self.PH-bh)/2));
         var rx=(self.dragRect.x-ox)/bw,ry=(self.dragRect.y-oy)/bh;
         var rw=self.dragRect.w/bw,rh=self.dragRect.h/bh;
         self.zoomCX=Math.max(0,Math.min(1,rx+rw/2));
         self.zoomCY=Math.max(0,Math.min(1,ry+rh/2));
         var avg=(rw+rh)/2;
         self.zoomLevel=avg<0.15?8:avg<0.35?4:2;
         self.btnZoomReset.enabled=true;self.zoomMode=true;
         self.updateLevelButtons();self.renderPreview();
      }
      self.dragStart=null;self.dragRect=null;
   };

   function mkSlider(lbl,lo,hi,def,prec,key){
      var label=new Label(self);label.text=lbl+":";label.minWidth=185;
      var sld=new Slider(self);sld.minWidth=170;sld.setRange(0,500);
      var edt=new Edit(self);edt.readOnly=true;edt.minWidth=58;edt.maxWidth=58;
      function v2s(v){return Math.round((v-lo)/(hi-lo)*500);}
      function s2v(s){return lo+s/500*(hi-lo);}
      sld.value=v2s(def);edt.text=def.toFixed(prec);
      sld.onValueUpdated=function(s){
         var v=parseFloat(s2v(s).toFixed(prec));
         edt.text=v.toFixed(prec);
         self.p[key]=v;
         self.needsRefresh=true;
      };
      sld.onMouseRelease=function(){
         if(self.needsRefresh){self.needsRefresh=false;self.doRefresh();}
      };
      var row=new Sizer(false);row.spacing=4;
      row.add(label);row.add(sld);row.add(edt);
      row.setValue=function(v){edt.text=v.toFixed(prec);sld.value=v2s(v);self.p[key]=v;};
      return row;
   }

   function mkGroup(t){
      var g=new GroupBox(self);g.title=t;
      g.sizer=new Sizer(true);g.sizer.margin=6;g.sizer.spacing=4;
      return g;
   }

   // ── Starless selector ─────────────────────────────────────
   var slLbl=new Label(this); slLbl.text="Starless:"; slLbl.minWidth=55;
   this.starlessCombo=new ComboBox(this); this.starlessCombo.minWidth=160;
   for(var i=0;i<this.imageWindows.length;i++)
      this.starlessCombo.addItem(this.imageWindows[i].mainView.id);
   this.starlessCombo.currentItem=0;
   this.starlessCombo.onItemSelected=function(idx){
      self.starlessWin  = self.imageWindows[idx];
      self.srcWin       = self.starlessWin;
      self.srcView      = self.starlessWin.mainView;
      self.starlessOrig = new Image(self.starlessWin.mainView.image);
      self.origImg      = self.starlessOrig;
      self.previewImg   = scaleImage(self.starlessOrig, self.SCALE);
      // Re-scale stars to match new starless dimensions
      if(self.starsOrig !== null)
         self.starsPreview = self.starsOrig;
      closeAllWins(); self.zoomMode=false; self.btnZoomReset.enabled=false;
      var nPW=700, nPH=Math.round(700*self.starlessOrig.height/self.starlessOrig.width);
      if(nPH>560){nPH=560;nPW=Math.round(nPH*self.starlessOrig.width/self.starlessOrig.height);}
      self.PW=nPW; self.PH=nPH;
      self.canvas.setFixedSize(nPW,nPH); self.adjustToContents(); self.doRefresh();
   };

   // ── Stars selector ─────────────────────────────────────────
   var stLbl=new Label(this); stLbl.text="Stars:"; stLbl.minWidth=40;
   this.starsCombo=new ComboBox(this); this.starsCombo.minWidth=160;
   this.starsCombo.addItem("-- none --");
   for(var i=0;i<this.imageWindows.length;i++)
      this.starsCombo.addItem(this.imageWindows[i].mainView.id);
   this.starsCombo.currentItem=0;
   this.starsCombo.onItemSelected=function(idx){
      if(idx===0){
         self.starsOrig=null; self.starsPreview=null;
         // Reset blend slider to 0 when deselected
         self.slStarsBlend.setValue(0);
         self.p.starsBlend=0;
      } else {
         // Store full-res stars — blend uses normalized coords, no pre-scaling needed
         self.starsOrig     = new Image(self.imageWindows[idx-1].mainView.image);
         self.starsPreview  = self.starsOrig;   // same image, blend handles scaling
         // Set default blend to 50% and immediately show result
         self.slStarsBlend.setValue(50);
         self.p.starsBlend=50;
      }
      self.doRefresh();
   };

   var imgRow=new Sizer(false); imgRow.spacing=8;
   imgRow.add(slLbl); imgRow.add(this.starlessCombo);
   imgRow.add(stLbl); imgRow.add(this.starsCombo);
   imgRow.addStretch();

   var zHint=new Label(this);zHint.text="Drag on preview to zoom  \u00B7  Release slider to update";
   this.btnZoomReset=new PushButton(this);
   this.btnZoomReset.text="\u229F  Reset Zoom";this.btnZoomReset.enabled=false;
   this.btnZoomReset.onClick=function(){
      self.zoomMode=false;self.btnZoomReset.enabled=false;
      self.updateLevelButtons();self.renderPreview();
   };
   var zLbl=new Label(this);zLbl.text="Level:";
   this.btnZ2=new PushButton(this);this.btnZ2.text="2x";this.btnZ2.minWidth=36;
   this.btnZ4=new PushButton(this);this.btnZ4.text="4x";this.btnZ4.minWidth=36;
   this.btnZ8=new PushButton(this);this.btnZ8.text="8x";this.btnZ8.minWidth=36;
   this.btnZ2.onClick=function(){self.zoomLevel=2;if(self.zoomMode)self.renderPreview();};
   this.btnZ4.onClick=function(){self.zoomLevel=4;if(self.zoomMode)self.renderPreview();};
   this.btnZ8.onClick=function(){self.zoomLevel=8;if(self.zoomMode)self.renderPreview();};
   var zRow=new Sizer(false);zRow.spacing=6;
   zRow.add(zHint);zRow.addStretch();
   zRow.add(this.btnZoomReset);zRow.add(zLbl);
   zRow.add(this.btnZ2);zRow.add(this.btnZ4);zRow.add(this.btnZ8);

   this.g1=mkGroup("1 \u00B7 Clarity by Tone Zone");
   this.slClarityS=mkSlider("Shadows clarity",      -100,100,  0,1,"clarityS");
   this.slWidthS  =mkSlider("Shadows zone width",      5,100, 40,1,"widthS"  );
   this.slClarityM=mkSlider("Midtones clarity",     -100,100,  0,1,"clarityM");
   this.slWidthM  =mkSlider("Midtones zone width",     5,100, 50,1,"widthM"  );
   this.slClarityH=mkSlider("Highlights clarity",   -100,100,  0,1,"clarityH");
   this.slWidthH  =mkSlider("Highlights zone width",   5,100, 40,1,"widthH"  );
   this.g1.sizer.add(this.slClarityS);this.g1.sizer.add(this.slWidthS);
   this.g1.sizer.add(this.slClarityM);this.g1.sizer.add(this.slWidthM);
   this.g1.sizer.add(this.slClarityH);this.g1.sizer.add(this.slWidthH);

   this.g2=mkGroup("2 \u00B7 USM Parameters (global)");
   this.slSigma=mkSlider("Sigma",0.5,20.0,5.0,1,"sigma");
   this.g2.sizer.add(this.slSigma);

   this.g3=mkGroup("3 \u00B7 Luminance Sharpening");
   this.slLumSharpAmount   =mkSlider("Amount",         0,100,   0, 1,"lumSharpAmount"   );
   this.slLumSharpSigma    =mkSlider("Radius (sigma)", 0.5,10, 1.5, 1,"lumSharpSigma"   );
   this.slLumSharpThreshold=mkSlider("Threshold",      0, 30,   5,  1,"lumSharpThreshold");
   this.g3.sizer.add(this.slLumSharpAmount);
   this.g3.sizer.add(this.slLumSharpSigma);
   this.g3.sizer.add(this.slLumSharpThreshold);

   this.g5=mkGroup("5 \u00B7 Stars blend");
   // Stars slider uses its own mkSlider that fires doRefresh on every move
   // (same pattern as EasyStretch General Stretch)
   var starsSliderLbl=new Label(self);
   starsSliderLbl.text="Stars MTF amount:"; starsSliderLbl.minWidth=185;
   this.sldStars=new Slider(self); this.sldStars.minWidth=170; this.sldStars.setRange(0,500);
   this.edtStars=new Edit(self); this.edtStars.readOnly=true;
   this.edtStars.minWidth=58; this.edtStars.maxWidth=58;
   this.edtStars.text="0.0";
   this.sldStars.value=0;
   this.sldStars.onValueUpdated=function(s){
      var v=parseFloat((s/500*100).toFixed(1));
      self.edtStars.text=v.toFixed(1);
      self.p.starsBlend=v;
      self.doRefresh();
   };
   var starsRow2=new Sizer(false); starsRow2.spacing=4;
   starsRow2.add(starsSliderLbl); starsRow2.add(this.sldStars); starsRow2.add(this.edtStars);
   // setValue helper
   this.slStarsBlend={
      setValue:function(v){
         self.sldStars.value=Math.round(v/100*500);
         self.edtStars.text=v.toFixed(1);
         self.p.starsBlend=v;
      }
   };
   this.g5.sizer.add(starsRow2);

   this.btnReset=new PushButton(this);this.btnReset.text="\u21BA  Reset";
   this.btnReset.onClick=function(){
      self.slClarityS.setValue(0);         self.slWidthS.setValue(40);
      self.slClarityM.setValue(0);         self.slWidthM.setValue(50);
      self.slClarityH.setValue(0);         self.slWidthH.setValue(40);
      self.slSigma.setValue(5.0);
      self.slLumSharpAmount.setValue(0);   self.slLumSharpSigma.setValue(1.5);
      self.slLumSharpThreshold.setValue(5);
      self.slStarsBlend.setValue(0); self.doRefresh();
   };

   this.btnApply=new PushButton(this);this.btnApply.text="\u25B6  Apply & Continue";
   this.btnApply.toolTip="Bake parameters into working copy and reset sliders.";
   this.btnApply.onClick=function(){
      self.previewImg=processImage(self.previewImg,self.p);
      self.origImg   =processImage(self.origImg,   self.p);
      self.btnReset.onClick();closeAllWins();self.doRefresh();
   };

   this.btnCreate=new PushButton(this);this.btnCreate.text="\u2705  Create New Image";
   this.btnCreate.toolTip="Apply all parameters and create new image. Original untouched.";
   this.btnCreate.onClick=function(){
      var res=processImage(self.starlessOrig,self.p);
      // Blend full-resolution stars
      if(self.starsOrig!==null && self.p.starsBlend>0.5){
         // starsOrig is always full-res; blend uses normalized coords
         var starsFullRes=self.starsOrig;
         blendStarsOnImage(res, starsFullRes, self.p.starsBlend);
      }
      var nid=self.srcView.id+"_AstroMaxClarity";
      var nw=new ImageWindow(res.width,res.height,res.numberOfChannels,
                             res.bitsPerSample,res.isReal,res.numberOfChannels>1,nid);
      nw.mainView.beginProcess(0);nw.mainView.image.assign(res);nw.mainView.endProcess();
      nw.show();nw.bringToFront();
   };

   this.btnClose=new PushButton(this);this.btnClose.text="Close";
   this.btnClose.onClick=function(){closeAllWins();self.cancel();};

   var btnRow=new Sizer(false);btnRow.spacing=6;
   btnRow.add(this.btnReset);btnRow.add(this.btnApply);
   btnRow.addStretch();
   btnRow.add(this.btnCreate);btnRow.add(this.btnClose);

   var ctrlPanel=new Sizer(true);ctrlPanel.spacing=6;
   ctrlPanel.add(imgRow);ctrlPanel.add(zRow);
   ctrlPanel.add(this.g1);ctrlPanel.add(this.g2);
   ctrlPanel.add(this.g3);ctrlPanel.add(this.g5);
   ctrlPanel.addStretch();ctrlPanel.add(btnRow);

   var mainRow=new Sizer(false);mainRow.spacing=8;
   mainRow.add(this.canvas);mainRow.add(ctrlPanel);

   this.sizer=new Sizer(true);this.sizer.margin=8;
   this.sizer.add(mainRow);

   this.adjustToContents();
   this.doRefresh();
}

AstroMaxClarityDialog.prototype=new Dialog;

AstroMaxClarityDialog.prototype.updateLevelButtons=function(){
   this.btnZ2.enabled=this.zoomMode;
   this.btnZ4.enabled=this.zoomMode;
   this.btnZ8.enabled=this.zoomMode;
};

AstroMaxClarityDialog.prototype.renderPreview=function(){
   if(this.lastRes===null)return;
   this.previewBitmap=this.zoomMode
      ?renderZoom(this.lastRes,this.zoomCX,this.zoomCY,this.zoomLevel,this.PW,this.PH)
      :renderFull(this.lastRes,this.PW,this.PH);
   this.canvas.repaint();
};

AstroMaxClarityDialog.prototype.doRefresh=function(){
   if(this.busy)return;
   this.busy=true;
   try{
      var res=processImage(this.previewImg,this.p);
      // Blend stars directly onto result Image — no windows, no PixelMath
      if(this.starsPreview!==null && this.p.starsBlend>0.5){
         blendStarsOnImage(res, this.starsPreview, this.p.starsBlend);
      }
      this.lastRes=res;
      this.renderPreview();
   }catch(e){
      Console.writeln("AstroMaxClarity error: "+e);
   }
   this.busy=false;
};

function main(){
   Console.hide();
   var dlg=new AstroMaxClarityDialog();
   if(!dlg.srcView){Console.criticalln("AstroMaxClarity: No open images found.");return;}
   dlg.execute();
}

main();

