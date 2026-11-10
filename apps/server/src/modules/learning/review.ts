import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import type { MistakeService } from "./mistakes.js";
export class ReviewService {
  constructor(private mistakes: MistakeService) {}
  async listDue(scope: StudentScope, now: Date) {
    return (await this.mistakes.list(scope)).filter(
      (m) => m.dueAt && new Date(m.dueAt) <= now,
    );
  }
}
