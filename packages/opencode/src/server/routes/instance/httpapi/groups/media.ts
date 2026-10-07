import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

export const MediaApi = HttpApi.make("media").add(
  HttpApiGroup.make("media").add(
    HttpApiEndpoint.get("image", "/file/image", {
      query: Schema.Struct({ path: Schema.String }),
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    }),
    HttpApiEndpoint.get("video", "/file/video", {
      query: Schema.Struct({ path: Schema.String }),
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    }),
    HttpApiEndpoint.get("thumbnailGet", "/preview/thumbnail/:encodedDir", {
      params: Schema.Struct({ encodedDir: Schema.String }),
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    }),
    HttpApiEndpoint.post("thumbnailPut", "/preview/thumbnail/:encodedDir", {
      params: Schema.Struct({ encodedDir: Schema.String }),
      payload: Schema.Struct({ png: Schema.String }),
      success: Schema.Struct({ success: Schema.Boolean }),
    }),
    HttpApiEndpoint.post("thumbnailCapture", "/preview/thumbnail/:encodedDir/capture", {
      params: Schema.Struct({ encodedDir: Schema.String }),
      success: Schema.Struct({ success: Schema.Boolean }),
    }),
  ),
)
