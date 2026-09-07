// 千夏桌宠 - 轻量 WebGL Spine 渲染器（对齐项目 WebGL 渲染通道语义）
// 顶点布局: [x, y, r, g, b, a, u, v] × 8 floats（与 SkeletonClipping.clipTriangles 输出一致，可零拷贝）
(function () {
  'use strict';

  const VERT_SRC = [
    'attribute vec2 aPos;',
    'attribute vec4 aColor;',
    'attribute vec2 aUV;',
    'uniform mat4 uMVP;',
    'varying vec2 vUV;',
    'varying vec4 vColor;',
    'void main() {',
    '  vColor = aColor;',
    '  vUV = aUV;',
    '  gl_Position = uMVP * vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  const FRAG_SRC = [
    'precision mediump float;',
    'varying vec2 vUV;',
    'varying vec4 vColor;',
    'uniform sampler2D uTex;',
    'void main() {',
    '  gl_FragColor = texture2D(uTex, vUV) * vColor;',
    '  if (gl_FragColor.a <= 0.001) discard;',
    '}'
  ].join('\n');

  const QUAD_TRIANGLES = [0, 1, 2, 2, 3, 0];

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  class SpineWebGLRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: false,
        antialias: true,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance'
      });
      if (!gl) throw new Error('WebGL not supported');
      this.gl = gl;
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('program: ' + gl.getProgramInfoLog(prog));
      }
      this.program = prog;
      this.aPos = gl.getAttribLocation(prog, 'aPos');
      this.aColor = gl.getAttribLocation(prog, 'aColor');
      this.aUV = gl.getAttribLocation(prog, 'aUV');
      this.uMVP = gl.getUniformLocation(prog, 'uMVP');
      this.uTex = gl.getUniformLocation(prog, 'uTex');

      this.stride = 8 * 4; // 8 floats
      const maxVerts = 65535;
      this.vbo = gl.createBuffer();
      this.ibo = gl.createBuffer();
      this.vertData = new Float32Array(maxVerts * 8);
      this.indexData = new Uint16Array(maxVerts * 3 / 2);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      // 预乘 alpha 管线（Chromium 解码输出预乘数据）
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      this.clipper = new spine.SkeletonClipping();
      this.tempColor = new spine.Color();
      // 关键：clipTriangles 必须收到真实 dark Color，否则走 NoRender 分支（无 UV/颜色输出，顶点布局错乱）
      this.tempDark = new spine.Color(0, 0, 0, 1);
      this.clipperVertices = new Float32Array(8192);   // x,y 缓存
      this.quadVertices = new Float32Array(8);
      this.scratchVerts = new Float32Array(4096 * 8);  // [x,y,r,g,b,a,u,v] scratch（单附件）
      this.scratchXY = new Float32Array(4096 * 2);     // scratch xy（供 clip 的 vertices 参数不用 uv）
      this.scratchClipped = new Float32Array(16384);   // clipper 输出拷贝缓冲


      // 状态
      this.vCount = 0;
      this.iCount = 0;
      this.currentPage = -1;
      this.textures = [];   // [{wrap, pageIndex}]
    }

    makeTexture(image, pageIndex) {
      const gl = this.gl;
      // Chromium 解码 WebP/PNG 输出预乘 alpha 数据 → 上传时保持预乘，混合用 (ONE, ONE_MINUS_SRC_ALPHA)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const wrap = {
        glTexture: t,
        pageIndex,
        image,
        setFilters() {},
        setWraps() {},
        dispose() { gl.deleteTexture(t); }
      };
      this.textures.push(wrap);
      return wrap;
    }

    setViewport(widthCss, heightCss, dpr) {
      const w = Math.max(1, Math.round(widthCss * dpr));
      const h = Math.max(1, Math.round(heightCss * dpr));
      this.gl.viewport(0, 0, w, h);
      return [w, h];
    }

    begin() {
      this.vCount = 0;
      this.iCount = 0;
      this.currentPage = -1;
      this.statSlots = 0;
      this.statAtt = 0;
      this.statTris = 0;
      this.statDraws = 0;
    }

    // 累积一个附件: vertexArray = [x,y,r,g,b,a,u,v]*n ; indices 相对该附件
    _push(vertexArray, vertexCount, indices, textureWrap) {
      const pageIdx = textureWrap ? textureWrap.pageIndex : 0;
      if (pageIdx !== this.currentPage && this.iCount > 0) this._flush();
      this.currentPage = pageIdx;

      const vCountF = vertexCount;
      if (this.vCount + vCountF > this.vertData.length) {
        this._flush();
        this.currentPage = pageIdx;
        if (vCountF > this.vertData.length) throw new Error('vertex overflow');
      }
      this.vertData.set(vertexArray.subarray(0, vCountF), this.vCount);
      const startVertex = this.vCount / 8;
      for (let i = 0; i < indices.length; i++) {
        this.indexData[this.iCount++] = startVertex + indices[i];
      }
      this.vCount += vCountF;
    }

    _flush() {
      const gl = this.gl;
      if (this.iCount === 0) return;
      this.statTris += this.iCount / 3;
      this.statDraws++;
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.vertData.subarray(0, this.vCount), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexData.subarray(0, this.iCount), gl.DYNAMIC_DRAW);

      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, this.stride, 0);
      gl.enableVertexAttribArray(this.aColor);
      gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, this.stride, 8);
      gl.enableVertexAttribArray(this.aUV);
      gl.vertexAttribPointer(this.aUV, 2, gl.FLOAT, false, this.stride, 24);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[this.currentPage].glTexture);
      gl.uniform1i(this.uTex, 0);
      gl.uniformMatrix4fv(this.uMVP, false, this.mvp);

      gl.drawElements(gl.TRIANGLES, this.iCount, gl.UNSIGNED_SHORT, 0);
      this.iCount = 0;
      this.vCount = 0;
    }

    clear(r, g, b, a) {
      const gl = this.gl;
      if (this.noBlend) gl.disable(gl.BLEND);
      else gl.enable(gl.BLEND);
      gl.clearColor(r === undefined ? 0 : r, g === undefined ? 0 : g, b === undefined ? 0 : b, a === undefined ? 0 : a);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // 主入口: 渲染一个 Skeleton。mvp 为 Float32Array(16) 列主序。
    draw(skeleton, mvp) {
      this.mvp = mvp;
      const clipper = this.clipper;
      this.begin();
      let flush = false;

      for (let slotIdx = 0; slotIdx < skeleton.drawOrder.length; slotIdx++) {
        const slot = skeleton.drawOrder[slotIdx];
        const attachment = slot.getAttachment();
        this.statSlots++;
        if (attachment instanceof spine.ClippingAttachment) {
          if (!this.ignoreClip) clipper.clipStart(slot, attachment);
          continue;
        }
        if (!(attachment instanceof spine.RegionAttachment) && !(attachment instanceof spine.MeshAttachment) && !(attachment instanceof spine.BoundingBoxAttachment)) {
          clipper.clipEndWithSlot(slot);
          continue;
        }
        if (!(attachment instanceof spine.RegionAttachment) && !(attachment instanceof spine.MeshAttachment)) {
          clipper.clipEndWithSlot(slot);
          continue;
        }

        this.statAtt++;
        // 颜色 = skeleton.color × slot.color × attachment.color
        const light = this.tempColor;
        light.set(skeleton.color.r * slot.color.r * attachment.color.r,
                  skeleton.color.g * slot.color.g * attachment.color.g,
                  skeleton.color.b * slot.color.b * attachment.color.b,
                  skeleton.color.a * slot.color.a * attachment.color.a);

        const textureWrap = attachment.region ? attachment.region.texture : null;

        if (attachment instanceof spine.RegionAttachment) {
          const att = attachment;
          const quad = this.quadVertices;
          att.computeWorldVertices(slot, quad, 0, 2);
          const uvs = att.uvs;
          const verts = this.scratchVerts;
          for (let i = 0; i < 4; i++) {
            const o = i * 8;
            verts[o] = quad[i * 2];
            verts[o + 1] = quad[i * 2 + 1];
            verts[o + 2] = light.r; verts[o + 3] = light.g; verts[o + 4] = light.b; verts[o + 5] = light.a;
            verts[o + 6] = uvs[i * 2];
            verts[o + 7] = uvs[i * 2 + 1];
          }
          if (clipper.isClipping() && !this.ignoreClip) {
            clipper.clipTriangles(this._xy(verts, 4), 8, QUAD_TRIANGLES, QUAD_TRIANGLES.length, uvs, light, this.tempDark, false);
            this._pushClipped(clipper, textureWrap);
          } else {
            this._push(verts, 32, QUAD_TRIANGLES, textureWrap);
          }
        } else if (attachment instanceof spine.MeshAttachment) {
          const att = attachment;
          const vlen = att.worldVerticesLength;
          const xy = this.clipperVertices;
          if (xy.length < vlen + 8) this.clipperVertices = new Float32Array(vlen + 8192);
          att.computeWorldVertices(slot, 0, vlen, this.clipperVertices, 0, 2);
          const uvs = att.uvs;
          const vcount = vlen >> 1;
          const verts = this.scratchVerts;
          for (let i = 0; i < vcount; i++) {
            const o = i * 8;
            verts[o] = this.clipperVertices[i * 2];
            verts[o + 1] = this.clipperVertices[i * 2 + 1];
            verts[o + 2] = light.r; verts[o + 3] = light.g; verts[o + 4] = light.b; verts[o + 5] = light.a;
            verts[o + 6] = uvs[i * 2];
            verts[o + 7] = uvs[i * 2 + 1];
          }
          const tris = att.triangles;
          if (clipper.isClipping() && !this.ignoreClip) {
            clipper.clipTriangles(this._xy(verts, vcount), vcount * 2, tris, tris.length, uvs, light, this.tempDark, false);
            this._pushClipped(clipper, textureWrap);
          } else {
            this._push(verts, vcount * 8, tris, textureWrap);
          }
        }
        clipper.clipEndWithSlot(slot);
      }
      clipper.clipEnd();
      this._flush();
    }

    _xy(verts, vcount) {
      const out = this.scratchXY;
      for (let i = 0; i < vcount; i++) {
        out[i * 2] = verts[i * 8];
        out[i * 2 + 1] = verts[i * 8 + 1];
      }
      return out;
    }

    _pushClipped(clipper, textureWrap) {
      const cv = clipper.clippedVertices;
      const ct = clipper.clippedTriangles;
      if (cv.length === 0 || ct.length === 0) return;
      // clipper 输出已经是 [x,y,r,g,b,a,u,v] × n，零拷贝（仅拷贝到 scratch）
      if (this.scratchClipped.length < cv.length) this.scratchClipped = new Float32Array(cv.length);
      this.scratchClipped.set(cv);
      this._push(this.scratchClipped, cv.length, ct, textureWrap);
    }
  }

  window.SpineGfx = { SpineWebGLRenderer };
})();
