import type { NextConfig } from "next";
import { MAX_PHOTO_BYTES } from "./src/lib/photos";

// Next.js caps Server Action request bodies at 1 MB by default. Branch/court
// photo uploads (addBranchPhotoAction / addCourtPhotoAction in
// src/app/dashboard/listings/actions.ts) post the file through a Server
// Action's FormData, so that 1 MB default silently overrides this app's own
// MAX_PHOTO_BYTES check in src/lib/listings/photos.ts — a 2 MB photo would
// be rejected by the framework with a generic "Body exceeded 1 MB limit"
// error before addPhoto() ever runs its own, more helpful "over 5 MB" check.
//
// The limit here must be MAX_PHOTO_BYTES *plus* headroom, not equal to it:
// the body is multipart/form-data, so on top of the raw file bytes it also
// carries MIME boundaries/headers, the other form fields (branchId/courtId),
// and React's Server Action action-id payload. A limit of exactly
// MAX_PHOTO_BYTES would still reject a file that is itself right at the
// app's own allowed size. 1 MB of headroom comfortably covers that overhead.
//
// Do NOT remove this and let it fall back to the framework default — that
// silently re-breaks every upload above 1 MB.
const SERVER_ACTION_BODY_SIZE_LIMIT_BYTES = MAX_PHOTO_BYTES + 1024 * 1024;

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: SERVER_ACTION_BODY_SIZE_LIMIT_BYTES,
    },
  },
};

export default nextConfig;
