/* Stable C ABI exported by allinone.dll.
 *
 * The WebView2 host (and the --engine subprocess) are the only callers. Everything
 * crossing this boundary is UTF-8 JSON; binary payloads are base64 inside the
 * envelope. The ABI is versioned so the host can refuse an incompatible DLL.
 *
 * Envelope:
 *   success, JSON result : {"ok":true,"result":...}
 *   success, binary      : {"ok":true,"bin":"<base64>"}
 *   failure              : {"ok":false,"error":"<code or message>"}
 */
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

#define AIO_ABI_VERSION 1

#if defined(_WIN32)
#define AIO_EXPORT __declspec(dllexport)
#else
#define AIO_EXPORT
#endif

/* Returns a heap string owned by the DLL; release it with aio_free(). */
AIO_EXPORT const char *aio_call(const char *op, const char *json_args);

AIO_EXPORT void aio_free(void *ptr);

AIO_EXPORT int aio_abi_version(void);

#ifdef __cplusplus
}
#endif
