export type UUID = string;
export type Instant = string;
export type Actor = { userId: UUID; role: "admin" | "student" };
export type StudentScope = { actor: Actor; studentId: UUID };
export type EvidenceRef = { kind: string; id: UUID; versionId?: UUID };
