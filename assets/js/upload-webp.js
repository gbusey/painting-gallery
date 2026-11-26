// WebP encoding with libwebp compiled to WebAssembly (assets/vendor/webp/).
// Safari can display WebP but cannot save it from a canvas, so the upload page
// encodes the images itself.

const OPTIONS = {
  quality: 90,
  target_size: 0,
  target_PSNR: 0,
  method: 4,
  sns_strength: 50,
  filter_strength: 60,
  filter_sharpness: 0,
  filter_type: 1,
  partitions: 0,
  segments: 4,
  pass: 1,
  show_compressed: 0,
  preprocessing: 0,
  autofilter: 0,
  partition_limit: 0,
  alpha_compression: 1,
  alpha_filtering: 1,
  alpha_quality: 100,
  lossless: 0,
  exact: 0,
  image_hint: 0,
  emulate_jpeg_size: 0,
  thread_level: 0,
  low_memory: 0,
  near_lossless: 100,
  use_delta_palette: 0,
  use_sharp_yuv: 0,
};

let encoderPromise;

/** Load the encoder (the faster SIMD build where the browser supports it). */
export function loadEncoder() {
  encoderPromise ??= (async () => {
    try {
      const { default: factory } = await import('../vendor/webp/webp_enc_simd.js');
      return await factory({ noInitialRun: true });
    } catch {
      const { default: factory } = await import('../vendor/webp/webp_enc.js');
      return await factory({ noInitialRun: true });
    }
  })();
  encoderPromise.catch(() => { encoderPromise = undefined; });
  return encoderPromise;
}

/** Encode RGBA pixels ({ width, height, data }) as WebP bytes. */
export async function encodeWebP(image, quality = 90) {
  const encoder = await loadEncoder();
  const result = encoder.encode(image.data, image.width, image.height, { ...OPTIONS, quality });
  if (!result) throw new Error('WebP encoding failed.');
  return new Uint8Array(result);
}
