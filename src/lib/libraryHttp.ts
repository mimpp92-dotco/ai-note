import type { LibraryDocument, LibraryVersion } from "@/domain/library";
import { LibraryRepositoryError } from "@/lib/library";
import {
  readResolvedLibraryState,
  toPublicLibraryResponse,
} from "@/lib/libraryService";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";

export async function authoritativeLibraryResponse(status = 200): Promise<Response> {
  const state = await readResolvedLibraryState();
  return jsonNoStore(toPublicLibraryResponse(state), status);
}

export async function runPublicLibraryMutation(input: {
  expected: LibraryVersion;
  reducer: (document: LibraryDocument) => LibraryDocument;
}): Promise<Response> {
  const state = await readResolvedLibraryState();
  if (state.mode !== "ready") {
    return jsonNoStore({
      error: {
        code: "library_unavailable",
        message: "조직 정보를 현재 변경할 수 없습니다",
      },
      ...toPublicLibraryResponse(state),
    }, 503);
  }
  try {
    await state.repository.transact({ expected: input.expected, reducer: input.reducer });
  } catch (error) {
    if (error instanceof LibraryRepositoryError && error.code === "version_conflict") {
      const current = await readResolvedLibraryState();
      return jsonNoStore({
        error: {
          code: "library_revision_conflict",
          message: "최신 상태를 확인한 뒤 다시 시도해 주세요",
        },
        ...toPublicLibraryResponse(current),
      }, 409);
    }
    if (error instanceof LibraryRepositoryError && error.code === "durability_pending") {
      return publicErrorResponse("internal_error", 503);
    }
    return publicErrorResponse("invalid_request", 400);
  }
  return authoritativeLibraryResponse();
}
