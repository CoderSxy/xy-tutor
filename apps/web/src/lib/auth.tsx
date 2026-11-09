import type { SelectionDTO } from "../../../server/src/modules/learning/selections";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { api, ApiError, errorMessage, jsonBody } from "./api";
import type {
  Session,
  StudentEntry,
  StudentProfile,
  RevisionDTO,
  Capabilities,
} from "./types";
import { useRemote } from "./useRemote";
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
  catalog: RevisionDTO[];
  catalogLoading: boolean;
  catalogError: string;
  selected?: RevisionDTO;
  selectRevision: (r: RevisionDTO) => Promise<void>;
  selectionHistory: SelectionDTO[];
  historyLoading: boolean;
  historyError: string;
  capabilities?: Capabilities;
  scoped: (path: string) => string;
};
const AuthContext = createContext<AuthState | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [students, setStudents] = useState<StudentEntry[]>([]),
    [studentId, setStudent] = useState(""),
    [selectedId, setSelectedId] = useState("");
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
      setSelectedId(
        chosen ? (localStorage.getItem(`xy.textbook.${chosen}`) ?? "") : "",
      );
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
  const profile = useRemote<StudentProfile>(
    session && studentId ? `/api/students/${studentId}` : null,
  );
  const catalog = useRemote<RevisionDTO[]>(
    session ? "/api/catalog/textbooks" : null,
  );
  const caps = useRemote<Capabilities>(session ? "/api/capabilities" : null);
  const scopeKey = `${session?.actor.userId ?? ""}:${studentId}`;
  const activeScope = useRef(scopeKey);
  const historyVersion = useRef(0);
  activeScope.current = scopeKey;
  const [history, setHistory] = useState<{
    scope: string;
    items: SelectionDTO[];
    loading: boolean;
    error: string;
  }>({ scope: "", items: [], loading: false, error: "" });
  useEffect(() => {
    if (!session || !studentId || !catalog.data) return;
    const controller = new AbortController();
    const version = ++historyVersion.current;
    const current = () =>
      !controller.signal.aborted && version === historyVersion.current;
    const path = `/api/learning/selections?studentId=${encodeURIComponent(studentId)}`;
    setHistory({ scope: scopeKey, items: [], loading: true, error: "" });
    void (async () => {
      try {
        let items = await api<SelectionDTO[]>(path, {
          signal: controller.signal,
        });
        if (!current()) return;
        const stored = localStorage.getItem(`xy.textbook.${studentId}`);
        if (
          !items.length &&
          catalog.data?.some((r) => r.id === stored && r.status === "published")
        ) {
          items = await api<SelectionDTO[]>(path, {
            method: "POST",
            signal: controller.signal,
            ...jsonBody({ revisionId: stored }),
          });
        }
        if (current())
          setHistory({ scope: scopeKey, items, loading: false, error: "" });
      } catch (e) {
        if (current())
          setHistory({
            scope: scopeKey,
            items: [],
            loading: false,
            error: errorMessage(e),
          });
      }
    })();
    return () => controller.abort();
  }, [session?.actor.userId, studentId, catalog.data]);
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    setSession(null);
    setStudent("");
    setStudents([]);
  };
  const setStudentId = (id: string) => {
    if (students.some((s) => s.id === id)) {
      setSelectedId(localStorage.getItem(`xy.textbook.${id}`) ?? "");
      setStudent(id);
      if (session)
        localStorage.setItem(`xy.student.${session.actor.userId}`, id);
    }
  };
  const selectRevision = async (r: RevisionDTO) => {
    historyVersion.current++;
    setHistory((old) =>
      old.scope === scopeKey
        ? { ...old, loading: false, error: "" }
        : { scope: scopeKey, items: [], loading: false, error: "" },
    );
    const items = await api<SelectionDTO[]>(
      `/api/learning/selections?studentId=${encodeURIComponent(studentId)}`,
      { method: "POST", ...jsonBody({ revisionId: r.id }) },
    );
    if (activeScope.current !== scopeKey)
      throw Error("学生档案已切换，请重新选择");
    setHistory({ scope: scopeKey, items, loading: false, error: "" });
    setSelectedId(r.id);
    localStorage.setItem(`xy.textbook.${studentId}`, r.id);
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
        catalog: catalog.data ?? [],
        catalogLoading:
          !!session && (catalog.loading || (!catalog.data && !catalog.error)),
        catalogError: catalog.error,
        selected: catalog.data?.find((r) => r.id === selectedId),
        selectRevision,
        selectionHistory: history.scope === scopeKey ? history.items : [],
        historyLoading:
          !!studentId && (history.scope !== scopeKey || history.loading),
        historyError: history.scope === scopeKey ? history.error : "",
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
