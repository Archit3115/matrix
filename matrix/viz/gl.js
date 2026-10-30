(function (root) {
  "use strict";
  // MX.gl: WebGL2 (WebGL1 fallback) universe renderer. No colour literals: colours arrive
  // as [r,g,b] 0..1 from the theme probe (MX.gl.parseColor).
  // Camera (3D): setCamera(panX, panY, scale, view) — view.m = column-major clip matrix (render.js builds it: perspective
  // orbit camera whose focal plane reproduces the old 2D screen = world * scale + pan + size / 2), view.D = focal distance
  // (world), view.near. Billboards are offset in CSS px after projection; radii scale by D / depth (perspective).
  // Points: Float32Array, PSTRIDE floats each = x, y, radius(world), glow, r, g, b, flags, z
  //   flags bits: 1 lift (1.25x + glow), 2 dim, 4 sun (centre pip + corona), 8 ring (accent).
  // Lines: Float32Array, LSTRIDE floats per segment = x0, y0, x1, y1, r, g, b, a, z0, z1; a > .5 = emphasis
  //   (never LOD-dropped); flow runs 0 -> 1 with a per-edge phase hashed from the endpoints. Clipped at the near plane.
  // Sprites: Float32Array, SSTRIDE floats each = x, y, z, size(world radius), r, g, b, a, kind (0 glow | 1 wash), rot;
  //   procedural soft-falloff atlas, depth-tested, no depth write, additive (or premultiplied over, caller sorts).
  // Draw order: clear -> density field (CMB) -> texture quad -> [depth on] point-core depth prepass -> sprites -> lines
  //   -> points. Depth: cores occlude what is behind them; halos, lines and sprites never write depth.
  const PSTRIDE = 9, LSTRIDE = 10, SSTRIDE = 10, STILE = 64, SKINDS = 2;
  const PRE = "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n";
  // Q: world -> clip; O: + CSS px offset (y down) at that depth; fg: 0..1 fog by depth (VW = D, near, fog0, fog1 x D)
  const PROJ = "uniform vec2 R;uniform vec3 C;uniform mat4 MV;uniform vec4 VW;" +
    "vec4 Q(vec3 w){return MV*vec4(w,1.);}" +
    "vec4 O(vec4 c,vec2 o){c.xy+=vec2(o.x,-o.y)*2./R*c.w;return c;}" +
    "float fg(float w){return smoothstep(VW.z*VW.x,VW.w*VW.x,w);}\n";
  const VS_PT = PROJ +
    "attribute vec2 c;attribute vec4 p;attribute vec4 k;attribute float z;" +
    "uniform mediump float T;uniform float TW,GE,MN,MA,CO,DM,PA;uniform vec3 Z;uniform vec2 PK,FG,NF;" +
    "varying vec2 u;varying vec4 q;varying vec4 f;varying float e;" +
    "float b(float n){return mod(floor(k.w/n+.01),2.);}" +
    "void main(){float l=b(1.),s=b(4.),g=b(8.);vec4 v=Q(vec3(p.xy,z));" +
    "float r=p.z*clamp(C.z*Z.x,Z.y,Z.z)*clamp(VW.x/max(v.w,1e-6),PK.x,PK.y)*(1.+.25*l),a=1.;" +
    "if(r<MN){a=MA+(1.-MA)*r*r/(MN*MN);r=MN;}" +   // px floor: a fixed-size star (alpha >= MA), never a larger disc
    "e=max(1.+GE*(p.w+.5*l)+s*CO,g*(max(1.2,1.+3./r)+2./r));" +
    "float h=fract(sin(dot(p.xy,vec2(12.9898,78.233)))*43758.5453);" +
    "a*=(1.+TW*sin(T*(.6+h)+h*6.2832))*(1.-b(2.)*DM)*PA*(1.-FG.y*fg(v.w))*(1.-smoothstep(NF.x,NF.y,r/min(R.x,R.y)));" +
    "gl_Position=v.w<VW.y?vec4(2.,2.,2.,1.):O(v,c*r*e);u=c*e;q=vec4(k.rgb,a);f=vec4(r,p.w*(1.+l),s,g);}";
  // body = a hairline mark (bright outside, dim inside): ~1 px rim at BK.y, interior at BK.x (halved on discs > 20 ->
  // 120 px: close range stays a hairline symbol, never a filled disc), ink mixed BK.z toward A (desaturate: darker on
  // paper, lighter in the dark); solid below BK.w px radius (crisp points); a sun adds a centre dot PP x radius,
  // clamped to 1.4..2.5 px. Ring (flag 8): one crisp ~1 px hairline in A at max(1.2 r, r + 3 px). Halo (glow / corona)
  // only outside the disc, light and alpha both x HA (off at HA = 0: no hard light band). Depth prepass: solid points
  // only (a large disc never hides what is behind it).
  const FS_PT = PRE +
    "uniform vec3 A;uniform mediump float T;uniform float HA,DP,PP;uniform vec4 BK;" +
    "varying vec2 u;varying vec4 q;varying vec4 f;varying float e;" +
    "void main(){float d=length(u);if(d>e)discard;" +
    "if(DP>.5){if(d>1.||q.a<.5||f.x>BK.w+1.5)discard;gl_FragColor=vec4(0.);return;}" +
    "float w=1./max(f.x,1.),o=1.-smoothstep(1.-w,1.+w,d)," +
    "m=1.-clamp((d-1.)/max(e-1.,.001),0.,1.),x=step(1.,d);" +
    "float h=(f.y*.8+f.z*(.45+.25*sin(atan(u.y,u.x)*11.+T*.3)*sin(atan(u.y,u.x)*5.-T*.2)))*m*m*m*x;" +
    "float s=1.-smoothstep(BK.w,BK.w+1.5,f.x),r=clamp(1.-abs(d-1.+.6*w)*f.x,0.,1.),pr=clamp(PP,1.4*w,2.5*w),bi=BK.x*(1.-.5*smoothstep(20.,120.,f.x))," +
    "p=f.z*(1.-smoothstep(pr-.6*w,pr+.6*w,d)),k=o*max(max(s,bi),max(r*BK.y,p));" +
    "vec3 c=mix(q.rgb,A,BK.z);" +
    "float g=f.w*.55*(1.-smoothstep(.15*w,.75*w,abs(d-max(1.2,1.+3.*w))));" +
    "gl_FragColor=vec4(mix(c*(k+h*HA),A,g),clamp(max(k,g)+h*HA,0.,1.))*q.a;}";
  // h = half width + 0.5 px AA (LW <= 1: 1 px quad). LOD: only a hashed KP fraction of lines with
  // a <= .5 is drawn, at alpha / KP (same additive haze, fewer fragments); alpha < LC -> culled.
  // a > .5 (focus/path) is a code (scene.js T.hot/path/pq): u = (a - .6) / .04, j = round(u), strength
  // s = (u - j + .45) / .9; provenance m = j mod 3 -> 0 solid, 1 dash 4/3 px, 2 dot 1/3 px (render.js DASH; gaps keep
  // 25 %), from the x0,y0 end; tier t = j / 3: 0 crisp hot 1.1 px / .62 s, 1 faint hot 1 px / .4 s (both x 1 -> .4 as
  // screen length .15 -> .8 min(W, H)), 2 path 1.6 px / .95 s.
  // 3D: both ends projected, the one behind the near plane slid along the segment to it; width / dash / length in px.
  const VS_LN = PROJ +
    "attribute vec2 c;attribute vec4 p;attribute vec4 k;attribute vec2 z;uniform float LR,LW,LC,A,KP;uniform vec2 FG,NL;varying vec4 q;varying float d,y,h,m;" +
    "void main(){vec4 P0=Q(vec3(p.xy,z.x)),P1=Q(vec3(p.zw,z.y));float n=VW.y,bk=(P0.w<n&&P1.w<n)?1.:0.,nf=smoothstep(NL.x*VW.x,NL.y*VW.x,min(P0.w,P1.w));" +
    "if(P0.w<n)P0=mix(P0,P1,(n-P0.w)/(P1.w-P0.w));else if(P1.w<n)P1=mix(P1,P0,(n-P1.w)/(P0.w-P1.w));" +
    "vec2 v=(P1.xy/P1.w-P0.xy/P0.w)*R*.5;float L=length(v),x=c.x*.5+.5,o=k.a>.5?1.:0.," +
    "r=fract(sin(dot(p,vec4(12.9898,78.233,37.719,4.581)))*43758.5453),e=o>0.?1.:KP,u=(k.a-.6)/.04,j=floor(u+.5),t=floor(j/3.+.01);" +
    "h=o<1.?(LW>1.?LW*.5+.5:.5):t>1.?1.3:t>0.?.5:1.05;m=o*(j-3.*t);" +
    "q=vec4(k.rgb,(o<1.?k.a*min(LR/max(L,1.),1.):clamp((u-j+.45)/.9,0.,1.)*(t>1.?.95:(t>0.?.4:.62)*(1.-.6*smoothstep(.15,.8,L/min(R.x,R.y)))))*A*min(LW,1.)/e" +
    "*(1.-(1.-o)*FG.x*fg(mix(P0.w,P1.w,x)))*nf);" +
    "y=c.y*h;d=x*L+(1.-o)*r*997.;vec4 P=x>.5?P1:P0;P.xy+=(L>0.?vec2(-v.y,v.x)/L:v)*y*2./R*P.w;" +
    "gl_Position=bk>.5||q.a<LC||r>e?vec4(2.,2.,2.,1.):P;}";
  const FS_LN = PRE +
    "uniform float FL,T,SP,V;varying vec4 q;varying float d,y,h,m;" +
    "void main(){float z=fract((d-T*V)/SP),a=q.a*(1.+FL*8.*pow(z,12.))*clamp(h-abs(y)+step(h,.5),0.,1.);" +
    "if(m>.5&&m<2.5)a*=mix(.25,1.,clamp((m<1.5?4.5:1.5)-mod(d,m<1.5?7.:4.),0.,1.));" +
    "gl_FragColor=vec4(q.rgb*a,a);}";
  const VS_SP = PROJ +
    "attribute vec2 c;attribute vec4 p;attribute float z;uniform float MS,SK,SW;varying vec2 u;varying float w;" +
    "void main(){vec4 v=Q(vec3(p.xy,z));float r0=max(p.z*C.z*SK*VW.x/max(v.w,1e-6),.001),r=max(r0,MS);" +
    "gl_Position=v.w<VW.y?vec4(2.,2.,2.,1.):O(v,c*r);u=c;w=SW*(1.+p.w)*MS*MS/(r*r);}";
  // sprites: world-radius billboards (rot = m.y) from the procedural atlas tile m.x; fade under 2 px and when the
  // sprite outgrows SX x min(W, H) (camera inside a wash); colour premultiplied
  const VS_SPR = PROJ +
    "attribute vec2 c;attribute vec4 p;attribute vec4 k;attribute vec2 m;uniform float SA,SX,NT;varying vec2 u;varying vec4 q;" +
    "void main(){vec4 v=Q(p.xyz);float r=p.w*C.z*VW.x/max(v.w,1e-6),cs=cos(m.y),sn=sin(m.y),mr=min(R.x,R.y);" +
    "float a=k.a*SA*clamp(r*.5,0.,1.)*(1.-smoothstep(SX*mr,2.*SX*mr,r));" +
    "u=vec2((c.x*.5+.5+floor(m.x+.5))/NT,c.y*.5+.5);q=vec4(k.rgb*a,a);" +
    "gl_Position=v.w<VW.y||a<.002?vec4(2.,2.,2.,1.):O(v,vec2(c.x*cs-c.y*sn,c.x*sn+c.y*cs)*r);}";
  const FS_SPR = PRE + "uniform sampler2D S;varying vec2 u;varying vec4 q;void main(){gl_FragColor=q*texture2D(S,u).r;}";
  const FS_SP = PRE + "varying vec2 u;varying float w;void main(){gl_FragColor=vec4(w*exp(-4.*dot(u,u)));}";
  const VS_Q = "attribute vec2 c;varying vec2 v;void main(){v=c*.5+.5;gl_Position=vec4(c,0.,1.);}";
  const FS_BL = PRE +
    "uniform sampler2D S;uniform vec2 D;varying vec2 v;" +
    "void main(){vec2 a=D*1.3846,b=D*3.2308;" +
    "gl_FragColor=texture2D(S,v)*.227+(texture2D(S,v+a)+texture2D(S,v-a))*.3162" +
    "+(texture2D(S,v+b)+texture2D(S,v-b))*.0703;}";
  const FS_MAP = PRE +
    "uniform sampler2D S;uniform vec3 G[4];uniform vec2 R;uniform vec3 C;uniform float A,K,M,FL,GN;varying vec2 v;" +
    "uniform sampler2D N;float n(vec2 p){return texture2D(N,p*.015625).r;}" +
    "void main(){vec2 w=(vec2(v.x*2.-1.,1.-v.y*2.)*R*.5-C.xy)/C.z*K;" +
    "float m=n(w)*.6+n(w*2.7+vec2(17.3,5.1))*.4,t=clamp(1.-exp(-texture2D(S,v).r*GN)+(m-.5)*M,0.,1.),x=t*3.;" +
    "vec3 c=mix(mix(mix(G[0],G[1],clamp(x,0.,1.)),G[2],clamp(x-1.,0.,1.)),G[3],clamp(x-2.,0.,1.));" +
    "float a=clamp(t+FL*m,0.,1.)*A;gl_FragColor=vec4(c*a,a);}";
  const FS_TX = PRE + "uniform sampler2D S;uniform vec4 O;uniform float A;varying vec2 v;" +
    "void main(){gl_FragColor=texture2D(S,v*O.zw+O.xy)*A;}";
  const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  // value-noise lattice as a REPEAT texture (sin-hash noise tears into blocks on D3D)
  const NOISE = new Uint8Array(4096);
  for (let i = 0, z = 9; i < 4096; i++) NOISE[i] = (z = (z * 1664525 + 1013904223) >>> 0) >>> 24;
  // sprite atlas (LUMINANCE, STILE x SKINDS*STILE): 0 glow = gaussian core with a soft rim; 1 wash = watercolour blot,
  // lumpy edge (2-octave value noise on the radius), pigment pooling at the rim, paper granulation. Zero at every tile edge.
  const SATLAS = (function () {
    const T = STILE, out = new Uint8Array(T * T * SKINDS), L = 9, lat = new Float32Array(L * L * 2);
    for (let i = 0, z = 77; i < lat.length; i++) lat[i] = (z = (z * 1664525 + 1013904223) >>> 0) / 4294967296;
    const sm = t => t * t * (3 - 2 * t), st = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const vn = (x, y, o) => {                                   // bilinear value noise on an L x L lattice, x, y in [0, L-1)
      const i = Math.floor(x), j = Math.floor(y), fx = sm(x - i), fy = sm(y - j), at = (a, b) => lat[o + ((b % L) * L + (a % L))];
      return at(i, j) * (1 - fx) * (1 - fy) + at(i + 1, j) * fx * (1 - fy) + at(i, j + 1) * (1 - fx) * fy + at(i + 1, j + 1) * fx * fy;
    };
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const u = (x + 0.5) / T * 2 - 1, v = (y + 0.5) / T * 2 - 1, r = Math.hypot(u, v), win = 1 - st(0.9, 1, r);
      const g = Math.exp(-3.2 * r * r) * (1 - st(0.7, 1, r));
      const n1 = vn((u + 1) * 2 + 0.3, (v + 1) * 2 + 0.7, 0), n2 = vn((u + 1) * 3.9, (v + 1) * 3.9, L * L);
      const rr = r * (1 + 0.32 * (n1 - 0.5) + 0.12 * (n2 - 0.5));
      const w = ((1 - st(0.3, 0.92, rr)) * 0.7 + 0.42 * Math.exp(-Math.pow((rr - 0.8) / 0.09, 2))) * (0.8 + 0.2 * vn((u + 1) * 3.9 + 1.7, (v + 1) * 3.9 + 2.3, L * L));
      out[y * T * SKINDS + x] = Math.round(255 * Math.min(1, g) * win);
      out[y * T * SKINDS + T + x] = Math.round(255 * Math.min(1, Math.max(0, w)) * win);
    }
    return out;
  })();
  const NONE = {};
  const num = (v, d) => (typeof v === "number" ? v : d);

  // computed colour string (rgb/rgba: 0..255, color(srgb ..): 0..1) -> [r,g,b] 0..1
  function parseColor(s) {
    const v = String(s).match(/-?[\d.]+(e-?\d+)?/g) || [];
    const k = /^\s*color\(/.test(s) ? 1 : 255;
    return [0, 1, 2].map(i => Math.min(1, Math.max(0, (+v[i] || 0) / k)));
  }

  function create(cv, o) {
    o = o || {};
    const fail = r => ({ok: false, reason: r});
    if (!cv || !cv.getContext) return fail("no canvas");
    const at = {alpha: true, premultipliedAlpha: true, antialias: false, depth: true, stencil: false,
      preserveDrawingBuffer: !!o.preserve, powerPreference: "high-performance",
      failIfMajorPerformanceCaveat: !o.allowSoftware};
    let gl = null, v2 = false;
    try {
      if (!o.webgl1) gl = cv.getContext("webgl2", at);
      v2 = !!gl;
      if (!gl) gl = cv.getContext("webgl", at);
    } catch (e) { gl = null; }
    if (!gl) return fail("webgl unavailable (no gpu or software-only)");

    let ix = null, pr = null, qb = null, pb = null, lb = null, sb = null, tx = [], fb = [], img = null, fmt = null;
    let lost = false, dead = false, W = 1, H = 1, fw = 1, fh = 1, pCap = 0, lCap = 0, sCap = 0;
    const cam = new Float32Array([0, 0, 1]), acc = new Float32Array(3), ramp = new Float32Array(12);
    const mv = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1]), vw = new Float32Array([1, 1e-3, 1.1, 3]);
    const bg = new Float32Array(4), pts = {a: null, n: 0}, lns = {a: null, n: 0}, spr = {a: null, n: 0}, ds = o.ds || 8;
    const caps = {webgl2: v2, float: false};

    // prog() only compiles + links (no status query: with KHR_parallel_shader_compile that runs off-thread);
    // link() reads LINK_STATUS + the uniform table, which blocks until the link is done.
    function sh(t, s) {
      const x = gl.createShader(t);
      gl.shaderSource(x, s); gl.compileShader(x);
      return x;
    }
    function prog(vs, fs, an) {
      const p = gl.createProgram(), s = [sh(gl.VERTEX_SHADER, vs), sh(gl.FRAGMENT_SHADER, fs)];
      s.forEach(x => gl.attachShader(p, x));
      an.forEach((n, i) => gl.bindAttribLocation(p, i, n));
      gl.linkProgram(p);
      return {p, s, u: {}, n: an.length};
    }
    function link(o) {
      const p = o.p;
      if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost())
        throw new Error(o.s.map(x => gl.getShaderInfoLog(x)).join(" ") + gl.getProgramInfoLog(p));
      o.s.forEach(x => gl.deleteShader(x));
      for (let i = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0; i--;) {
        const n = gl.getActiveUniform(p, i).name.replace("[0]", "");
        o.u[n] = gl.getUniformLocation(p, n);
      }
    }
    // PSC: wait = ready(cb) callbacks while linking; poll COMPLETION_STATUS_KHR (non-blocking) from setTimeout
    // for up to 1.5 s, then link() blocks (bounded; virtual-time headless would otherwise never see completion)
    const PSC = gl.getExtension("KHR_parallel_shader_compile"), T0 = performance.now();
    let wait = null, err = "";
    function settle() {
      try { for (const k in pr) link(pr[k]); } catch (e) { err = String(e && e.message || e); dead = true; }
      const w = wait || []; wait = null; w.forEach(f => f(err));
    }
    function poll() {
      if (!wait || dead || gl.isContextLost()) return;  // lost: onRestored links synchronously
      if (performance.now() - T0 < 1500)
        for (const k in pr) if (!gl.getProgramParameter(pr[k].p, PSC.COMPLETION_STATUS_KHR)) return void setTimeout(poll, 8);
      settle();
    }
    function newTex() {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      tp(gl.LINEAR, gl.CLAMP_TO_EDGE);
      return t;
    }
    function tp(f, w) {
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, f);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, w);
    }
    // Low-res density targets: half-float when renderable + linear, else RGBA8.
    function targets() {
      const tries = [];
      if (v2 && gl.getExtension("EXT_color_buffer_float")) tries.push([gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT]);
      if (!v2) {
        const h = gl.getExtension("OES_texture_half_float");
        if (h && gl.getExtension("OES_texture_half_float_linear")) {
          gl.getExtension("EXT_color_buffer_half_float");
          tries.push([gl.RGBA, gl.RGBA, h.HALF_FLOAT_OES]);
        }
      }
      tries.push([gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE]);
      for (const f of tries) {
        fmt = f; alloc();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb[0]);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        if (ok) return (caps.float = f[2] !== gl.UNSIGNED_BYTE);
      }
    }
    function alloc() {
      for (let i = 0; i < 2; i++) {
        gl.bindTexture(gl.TEXTURE_2D, tx[i]);
        gl.texImage2D(gl.TEXTURE_2D, 0, fmt[0], fw, fh, 0, fmt[1], fmt[2], null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb[i]);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tx[i], 0);
      }
    }
    function upload(b, d, cap, per) {
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      if (d.a.length > cap) { gl.bufferData(gl.ARRAY_BUFFER, d.a, gl.DYNAMIC_DRAW); return d.a.length; }
      if (v2) gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.a, 0, Math.min(d.a.length, d.n * per));
      else gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.a);
      return cap;
    }
    function upTex() {
      if (!img || !tx[2]) return;
      gl.bindTexture(gl.TEXTURE_2D, tx[2]);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    function init() {
      if (v2) ix = {div: (l, d) => gl.vertexAttribDivisor(l, d), inst: (n, k) => gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, n, k)};
      else {
        const e = gl.getExtension("ANGLE_instanced_arrays");
        if (!e) throw new Error("no instancing");
        ix = {div: (l, d) => e.vertexAttribDivisorANGLE(l, d), inst: (n, k) => e.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, n, k)};
      }
      pr = {
        pt: prog(VS_PT, FS_PT, ["c", "p", "k", "z"]), ln: prog(VS_LN, FS_LN, ["c", "p", "k", "z"]),
        sp: prog(VS_SP, FS_SP, ["c", "p", "z"]), bl: prog(VS_Q, FS_BL, ["c"]),
        map: prog(VS_Q, FS_MAP, ["c"]), tx: prog(VS_Q, FS_TX, ["c"]), spr: prog(VS_SPR, FS_SPR, ["c", "p", "k", "m"]),
      };
      qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb); gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
      pb = gl.createBuffer(); lb = gl.createBuffer(); sb = gl.createBuffer(); pCap = lCap = sCap = 0;
      tx = [newTex(), newTex(), newTex(), newTex(), newTex()];
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, STILE * SKINDS, STILE, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, SATLAS);   // tx[4]
      gl.bindTexture(gl.TEXTURE_2D, tx[3]);
      tp(gl.LINEAR, gl.REPEAT);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 64, 64, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, NOISE);
      fb = [gl.createFramebuffer(), gl.createFramebuffer()];
      targets(); upTex(); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (pts.a) pCap = upload(pb, pts, 0, PSTRIDE);
      if (lns.a) lCap = upload(lb, lns, 0, LSTRIDE);
      if (spr.a) sCap = upload(sb, spr, 0, SSTRIDE);
      gl.disable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND);
    }
    try {
      init();
      if (PSC) { wait = []; setTimeout(poll, 0); } else settle();
      if (err) return fail(err);
    } catch (e) { return fail(String(e && e.message || e)); }

    function onLost(e) { e.preventDefault(); lost = true; if (o.onLost) o.onLost(); }
    function onRestored() {
      try { init(); for (const k in pr) link(pr[k]); lost = false; } catch (e) { dead = true; if (o.onError) o.onError(e); return; }
      if (wait) settle();
      if (o.onRestored) o.onRestored();
    }
    cv.addEventListener("webglcontextlost", onLost);
    cv.addEventListener("webglcontextrestored", onRestored);

    const f1 = (l, v, d) => gl.uniform1f(l, num(v, d)), strip = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    function use(p) {
      gl.useProgram(p.p);
      for (let i = 0; i < 4; i++) i < p.n ? gl.enableVertexAttribArray(i) : gl.disableVertexAttribArray(i);
      return p.u;
    }
    function view(u) { gl.uniform2f(u.R, W, H); gl.uniform3fv(u.C, cam); gl.uniformMatrix4fv(u.MV, false, mv); gl.uniform4fv(u.VW, vw); }
    function attr(i, b, sz, st, off, d) {
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.vertexAttribPointer(i, sz, gl.FLOAT, false, st, off); ix.div(i, d);
    }
    function quad(p) {
      const u = use(p); attr(0, qb, 2, 0, 0, 0); gl.uniform1i(u.S, 0);
      return u;
    }
    const PB = PSTRIDE * 4;
    function inst(u) {
      view(u);
      attr(0, qb, 2, 0, 0, 0); attr(1, pb, 4, PB, 0, 1);
      if (u === pr.pt.u) { attr(2, pb, 4, PB, 16, 1); attr(3, pb, 1, PB, 32, 1); } else attr(2, pb, 1, PB, 32, 1);
    }

    // density: additive splat into tx[0] at 1/ds res, then f.blur x (H, V) gaussian ping-pong
    function density(f) {
      gl.viewport(0, 0, fw, fh); gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb[0]); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      let u = use(pr.sp); inst(u);
      f1(u.MS, f.splat, 6); f1(u.SK, f.splatK, 3); f1(u.SW, f.splatW, 0.5);
      ix.inst(4, pts.n);
      gl.disable(gl.BLEND); gl.activeTexture(gl.TEXTURE0);
      u = quad(pr.bl);
      for (let i = 0, n = 2 * num(f.blur, 2); i < n; i++) {
        const j = i & 1;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb[1 - j]); gl.bindTexture(gl.TEXTURE_2D, tx[j]);
        gl.uniform2f(u.D, j ? 0 : 1 / fw, j ? 1 / fh : 0);
        strip();
      }
      gl.enable(gl.BLEND); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // f: one reused object, all optional. time (s); add (false = premultiplied over, for light bg);
    // layer alphas cmb, tex, lines, points; flow (particle gain), flowGap/flowSpeed (px, px/s); lineW (px), lineKeep,
    // lineCut (min alpha drawn), lenRef (px: longer lines fade); twinkle, glow, corona, dim, minR (px), minA (alpha at the floor),
    // haloA; body [interior a, rim a, ink -> accent mix, solid below px]; pip (sun centre, x radius); rz [k, lo, hi]: radius px = r * clamp(scale * k, lo, hi); CMB: noise (world freq), mottle,
    // floor, gain, blur (passes), splat (min px), splatK, splatW; texOff [u0, v0, su, sv].
    // 3D: persp [lo, hi] clamp of the D / depth radius factor; fog [d0, d1, lines, points]: alpha x (1 - k x smoothstep(d0 D,
    // d1 D, depth)); depth (false = no point-core prepass); sprites (alpha), spriteAdd (default = add), spriteNear (x min(W, H)).
    // nearFade [r0, r1]: a body fades out as its px radius grows r0 -> r1 x min(W, H) (the camera passing it); lineNear
    // [d0, d1]: a line fades in as its nearer end's depth grows d0 -> d1 x D (ends near / behind the camera: no streaks).
    function draw(f) {
      if (lost || dead || wait || gl.isContextLost()) return false;
      f = f || NONE;
      const t = num(f.time, 0), cmb = num(f.cmb, 0), lA = num(f.lines, 1), pA = num(f.points, 1), sA = num(f.sprites, 1);
      const fo = f.fog, pk = f.persp, main = f.add === false ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE;
      vw[2] = fo ? fo[0] : 1.1; vw[3] = fo ? fo[1] : 3;
      if (cmb > 0 && pts.n) density(f);
      gl.viewport(0, 0, cv.width, cv.height);
      gl.depthMask(true); gl.clearDepth(1);
      gl.clearColor(bg[0], bg[1], bg[2], bg[3]); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.blendFunc(gl.ONE, main);
      gl.activeTexture(gl.TEXTURE0);
      let u;
      if (cmb > 0 && pts.n) {
        u = quad(pr.map); gl.bindTexture(gl.TEXTURE_2D, tx[0]);
        gl.uniform2f(u.R, W, H); gl.uniform3fv(u.C, cam); gl.uniform3fv(u.G, ramp);
        f1(u.A, cmb); f1(u.K, f.noise, 0.005); f1(u.M, f.mottle, 0.35);
        f1(u.FL, f.floor, 0.08); f1(u.GN, f.gain, 1); gl.uniform1i(u.N, 1);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tx[3]);
        strip(); gl.activeTexture(gl.TEXTURE0);
      }
      if (num(f.tex, 0) > 0 && img) {
        u = quad(pr.tx); gl.bindTexture(gl.TEXTURE_2D, tx[2]);
        const q = f.texOff;
        gl.uniform4f(u.O, q ? q[0] : 0, q ? q[1] : 0, q ? q[2] : 1, q ? q[3] : 1); f1(u.A, f.tex);
        strip();
      }
      gl.enable(gl.DEPTH_TEST);
      const ptU = () => {
        const u = use(pr.pt); inst(u);
        const z = f.rz;
        gl.uniform3f(u.Z, z ? z[0] : 1, z ? z[1] : 0, z ? z[2] : 1e9);
        gl.uniform2f(u.PK, pk ? pk[0] : 0.3, pk ? pk[1] : 3); gl.uniform2f(u.FG, fo ? num(fo[2], 0.6) : 0.6, fo ? num(fo[3], 0.4) : 0.4);
        gl.uniform3fv(u.A, acc); f1(u.T, t); f1(u.TW, f.twinkle, 0);
        f1(u.GE, f.glow, 2.5); f1(u.CO, f.corona, 3);
        f1(u.MN, f.minR, 0.75); f1(u.MA, f.minA, 0.4); f1(u.DM, f.dim, 0.75);
        const nf = f.nearFade; gl.uniform2f(u.NF, nf ? nf[0] : 1e8, nf ? nf[1] : 2e8);
        f1(u.HA, f.haloA, 0.5); f1(u.PA, pA); f1(u.PP, f.pip, 0.2);
        const bk = f.body;
        gl.uniform4f(u.BK, bk ? bk[0] : 0.16, bk ? bk[1] : 1, bk ? bk[2] : 0, bk ? bk[3] : 2);
        return u;
      };
      if (pA > 0 && pts.n && f.depth !== false) {   // opaque body cores -> depth only
        gl.colorMask(false, false, false, false);
        u = ptU(); f1(u.DP, 1); ix.inst(4, pts.n);
        gl.colorMask(true, true, true, true);
      }
      gl.depthMask(false);
      if (sA > 0 && spr.n) {
        u = use(pr.spr); view(u);
        attr(0, qb, 2, 0, 0, 0); attr(1, sb, 4, SSTRIDE * 4, 0, 1); attr(2, sb, 4, SSTRIDE * 4, 16, 1); attr(3, sb, 2, SSTRIDE * 4, 32, 1);
        gl.bindTexture(gl.TEXTURE_2D, tx[4]); gl.uniform1i(u.S, 0);
        f1(u.SA, sA); f1(u.SX, f.spriteNear, 1.2); f1(u.NT, SKINDS);
        gl.blendFunc(gl.ONE, (f.spriteAdd == null ? f.add !== false : f.spriteAdd) ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
        ix.inst(4, spr.n);
        gl.blendFunc(gl.ONE, main);
      }
      if (lA > 0 && lns.n) {
        const LB = LSTRIDE * 4;
        u = use(pr.ln); view(u);
        attr(0, qb, 2, 0, 0, 0); attr(1, lb, 4, LB, 0, 1); attr(2, lb, 4, LB, 16, 1); attr(3, lb, 2, LB, 32, 1);
        gl.uniform2f(u.FG, fo ? num(fo[2], 0.6) : 0.6, 0);
        const nl = f.lineNear; gl.uniform2f(u.NL, nl ? nl[0] : -2, nl ? nl[1] : -1);
        f1(u.A, lA); f1(u.LR, f.lenRef, 1e9); f1(u.T, t);
        f1(u.FL, f.flow, 0); f1(u.SP, f.flowGap, 90); f1(u.V, f.flowSpeed, 40);
        f1(u.LW, f.lineW, 1); f1(u.LC, f.lineCut, 0.012); f1(u.KP, f.lineKeep, 1); ix.inst(4, lns.n);
      }
      if (pA > 0 && pts.n) { u = ptU(); f1(u.DP, 0); ix.inst(4, pts.n); }
      gl.disable(gl.DEPTH_TEST); gl.depthMask(true);
      return true;
    }

    return {
      ok: true, reason: "", gl, caps,
      get lost() { return lost; },
      get pending() { return !!wait; },
      ready(cb) { if (wait) wait.push(cb); else cb(err); },  // cb(error string, "" = linked)
      resize(w, h, cap) {
        const dpr = Math.min(root.devicePixelRatio || 1, cap || 2);
        W = Math.max(1, w); H = Math.max(1, h);
        const bw = Math.max(1, Math.round(W * dpr)), bh = Math.max(1, Math.round(H * dpr));
        if (cv.width !== bw) cv.width = bw;
        if (cv.height !== bh) cv.height = bh;
        const nw = Math.max(1, Math.ceil(W / ds)), nh = Math.max(1, Math.ceil(H / ds));
        if (nw !== fw || nh !== fh) { fw = nw; fh = nh; if (!lost && !dead) { alloc(); gl.bindFramebuffer(gl.FRAMEBUFFER, null); } }
        return dpr;
      },
      // v (3D): {m: 16 floats column-major world -> clip, D: focal distance (world), near (world)}; omitted = face-on ortho
      setCamera(x, y, s, v) {
        cam[0] = x; cam[1] = y; cam[2] = s;
        if (v) { mv.set(v.m); vw[0] = v.D; vw[1] = v.near; } else {
          mv.fill(0); mv[0] = 2 * s / W; mv[5] = -2 * s / H; mv[12] = 2 * x / W; mv[13] = -2 * y / H; mv[15] = 1; vw[0] = 1; vw[1] = -1e30;
        }
      },
      // c: {bg: [r,g,b,a?] | null (transparent), accent: [r,g,b], ramp: [[r,g,b] x4] dark -> bright}
      setColors(c) {
        if ("bg" in c) { const b = c.bg; for (let i = 0; i < 4; i++) bg[i] = b ? num(b[i], 1) * (i < 3 ? num(b[3], 1) : 1) : 0; }
        if (c.accent) acc.set(c.accent.slice(0, 3));
        if (c.ramp) for (let i = 0; i < 4; i++) ramp.set(c.ramp[Math.min(i, c.ramp.length - 1)].slice(0, 3), i * 3);
      },
      // (re)upload after mutating; a bigger array reallocates
      points(a, n) { pts.a = a; pts.n = n == null ? a.length / PSTRIDE | 0 : n; if (!lost && !dead) pCap = upload(pb, pts, pCap, PSTRIDE); },
      lines(a, n) { lns.a = a; lns.n = n == null ? a.length / LSTRIDE | 0 : n; if (!lost && !dead) lCap = upload(lb, lns, lCap, LSTRIDE); },
      sprites(a, n) { spr.a = a; spr.n = a ? (n == null ? a.length / SSTRIDE | 0 : n) : 0; if (a && !lost && !dead) sCap = upload(sb, spr, sCap, SSTRIDE); },
      texture(src) { img = src || null; if (!lost && !dead) upTex(); },
      draw,
      destroy() {
        if (dead) return;
        dead = true;
        cv.removeEventListener("webglcontextlost", onLost);
        cv.removeEventListener("webglcontextrestored", onRestored);
        if (!gl.isContextLost()) {
          for (const k in pr) gl.deleteProgram(pr[k].p);
          [qb, pb, lb, sb].forEach(b => gl.deleteBuffer(b));
          tx.forEach(t => gl.deleteTexture(t)); fb.forEach(b => gl.deleteFramebuffer(b));
        }
        pts.a = lns.a = spr.a = img = null;
      },
    };
  }

  // ---- MX.gl.sprites: renderer-independent registry of billboard layers (watercolour washes, glow halos) ----
  // set(list, layer = "default"): replace one named layer; list items {pos: [x, y, z] (world; an offset when anchored),
  //   size: world radius, color: [r, g, b] 0..1 or a computed CSS colour, alpha 0..1, kind: "glow" | "wash" (or 0 | 1),
  //   rot: radians, body: node index (anchor: follows that body), galaxy: galaxy index (anchor: follows its centre)}.
  // clear(layer?) | layers() | count | version (bumps on every change). auto (default true): render.js keeps a basic
  // "basic" layer (galaxy washes + sun halos); set auto = false (or overwrite "basic") to own the look.
  // pack(base, fwd) -> {a: Float32Array SSTRIDE, n}: base(item, out3) resolves anchors (false = skip); fwd [x, y, z] =
  //   view direction -> back-to-front order (needed only for premultiplied-over blending).
  const reg = new Map(), KIND = {glow: 0, wash: 1};
  let sver = 0, sbuf = new Float32Array(0), skey = new Float64Array(0), sord = new Int32Array(0);
  const B3 = [0, 0, 0];
  const sprites = {
    STRIDE: SSTRIDE, KIND, auto: true,
    set(list, layer) { reg.set(layer == null ? "default" : String(layer), Array.isArray(list) ? list.slice() : []); sver++; },
    clear(layer) { if (layer == null) reg.clear(); else reg.delete(String(layer)); sver++; },
    layers: () => [...reg.keys()],
    get count() { let n = 0; reg.forEach(l => { n += l.length; }); return n; },
    get version() { return sver; },
    pack(base, fwd) {
      const n0 = sprites.count;
      if (sbuf.length < n0 * SSTRIDE) { sbuf = new Float32Array(n0 * SSTRIDE); skey = new Float64Array(n0); sord = new Int32Array(n0); }
      let n = 0;
      reg.forEach(list => {
        for (const it of list) {
          if (!it) continue;
          B3[0] = B3[1] = B3[2] = 0;
          if (base && base(it, B3) === false) continue;
          const p = it.pos || B3, c = typeof it.color === "string" ? parseColor(it.color) : it.color || [1, 1, 1], o = n * SSTRIDE;
          const x = B3[0] + (it.pos ? +p[0] || 0 : 0), y = B3[1] + (it.pos ? +p[1] || 0 : 0), z = B3[2] + (it.pos ? +p[2] || 0 : 0);
          sbuf[o] = x; sbuf[o + 1] = y; sbuf[o + 2] = z; sbuf[o + 3] = num(it.size, 1);
          sbuf[o + 4] = c[0]; sbuf[o + 5] = c[1]; sbuf[o + 6] = c[2]; sbuf[o + 7] = num(it.alpha, 1);
          sbuf[o + 8] = typeof it.kind === "number" ? it.kind : KIND[it.kind] || 0; sbuf[o + 9] = num(it.rot, 0);
          if (fwd) skey[n] = x * fwd[0] + y * fwd[1] + z * fwd[2];
          n++;
        }
      });
      if (fwd && n > 1) {                              // back-to-front: farthest along the view direction first
        for (let j = 0; j < n; j++) sord[j] = j;
        const ord = Array.prototype.slice.call(sord.subarray(0, n)).sort((a, b) => skey[b] - skey[a]), tmp = sbuf.slice(0, n * SSTRIDE);
        for (let j = 0; j < n; j++) sbuf.set(tmp.subarray(ord[j] * SSTRIDE, ord[j] * SSTRIDE + SSTRIDE), j * SSTRIDE);
      }
      return {a: sbuf, n};
    },
  };

  const api = {create, parseColor, PSTRIDE, LSTRIDE, SSTRIDE, sprites, atlas: {data: SATLAS, tile: STILE, kinds: SKINDS}};
  (root.MX || (root.MX = {})).gl = api;   // inline after state.js (it assigns window.MX)
})(typeof window !== "undefined" ? window : this);
