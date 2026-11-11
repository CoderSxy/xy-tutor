import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { api, ApiError, errorMessage } from "./api";
import type {
  Session,
  StudentEntry,
  StudentProfile,
  Capabilities,
} from "./types";
import { useRemote } from "./useRemote";
import { useStudentVisit } from "../features/student-insights/useStudentVisit";
type AuthState = {
  session: Session | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  students: StudentEntry[];
  studentId: string;
  setStudentId: (id: string) => void;
  profile?: StudentProfile;
  capabilities?: Capabilities;
  scoped: (path: string) => string;
};
const AuthContext = createContext<AuthState | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [students, setStudents] = useState<StudentEntry[]>([]),
    [studentId, setStudent] = useState("");
  const refresh = useCallback(async () => {
    setError("");
    try {
      const s = await api<Session>("/api/auth/session");
      setSession(s);
      const entries = await api<StudentEntry[]>("/api/students");
      setStudents(entries);
      const stored = localStorage.getItem(`xy.student.${s.actor.userId}`);
      const chosen = entries.some((e) => e.id === stored)
        ? stored!
        : (s.studentId ?? entries[0]?.id ?? "");
      if (chosen) localStorage.removeItem(`xy.textbook.${chosen}`);
      setStudent(chosen);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401))
        setError(errorMessage(e));
      setSession(null);
      setStudents([]);
      setStudent("");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useStudentVisit(session?.actor.role === "student");
  const profile = useRemote<StudentProfile>(
    session && studentId ? `/api/students/${studentId}` : null,
  );
  const caps = useRemote<Capabilities>(session ? "/api/capabilities" : null);
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    setSession(null);
    setStudent("");
    setStudents([]);
  };
  const setStudentId = (id: string) => {
    if (students.some((s) => s.id === id)) {
      setStudent(id);
      if (session)
        localStorage.setItem(`xy.student.${session.actor.userId}`, id);
    }
  };
  const scoped = (path: string) =>
    studentId
      ? path +
        (path.includes("?") ? "&" : "?") +
        "studentId=" +
        encodeURIComponent(studentId)
      : path;
  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        error,
        refresh,
        logout,
        students,
        studentId,
        setStudentId,
        profile: profile.data,
        capabilities: caps.data,
        scoped,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw Error("AuthProvider missing");
  return value;
}
