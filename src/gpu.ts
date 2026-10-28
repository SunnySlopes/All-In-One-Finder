/** Best-effort GPU model name for status lines; empty string when unavailable. */
let cached: string | undefined;

export function gpuRendererName(): string {
  if (cached !== undefined) return cached;
  cached = '';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
    if (!gl) return cached;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
    // Chromium/Edge: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)".
    const angle = /ANGLE \([^,]+,\s*([^,]+?)(?:\s+Direct3D\d+[^,]*)?,\s*[^)]+\)/.exec(raw);
    const name = (angle ? angle[1] : raw).replace(/\s+/g, ' ').trim();
    if (name) cached = name;
  } catch {
    // WebGL is unavailable in some remote/software configurations; the caller falls back.
  }
  return cached;
}
