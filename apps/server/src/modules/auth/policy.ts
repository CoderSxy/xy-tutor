import type { Actor } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
export function requireAdmin(actor: Actor): void {
  if (actor.role !== "admin")
    throw new AppError("FORBIDDEN", 403, "需要管理员权限");
}
