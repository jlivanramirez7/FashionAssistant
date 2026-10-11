// src/types.ts mentions two DOM types (CapturedFrame.image). The server
// typechecks without lib "DOM", so declare them as opaque here. The server
// never uses them; this file has no runtime effect.
interface ImageBitmap { readonly width: number; readonly height: number }
interface ImageData { readonly width: number; readonly height: number }
