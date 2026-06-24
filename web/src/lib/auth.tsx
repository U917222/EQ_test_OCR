import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ApiError, postApi } from "@/lib/api";
import { Me, Role } from "@/lib/types";

const roleRank: Record<Role, number> = {
  operator: 1,
  reviewer: 2,
  admin: 3,
};

type AuthState = {
  user: Me | null;
  loading: boolean;
  error: ApiError | Error | null;
  can: (minimumRole: Role) => boolean;
  reload: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    postApi<Record<string, never>, Me>("me", {})
      .then(setUser)
      .catch((caught: unknown) => {
        setUser(null);
        setError(caught instanceof Error ? caught : new Error("認証情報を取得できませんでした。"));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      error,
      can: (minimumRole: Role) => {
        if (!user) return false;
        return roleRank[user.role] >= roleRank[minimumRole];
      },
      reload: () => window.location.reload(),
    }),
    [error, loading, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

export function isReviewerPlus(role?: Role) {
  return role === "reviewer" || role === "admin";
}
