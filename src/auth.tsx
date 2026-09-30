import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient, type AuthSession } from "./api";

interface AuthContextValue {
  session: AuthSession | null;
  loading: boolean;
  login: (user: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
const authKey = ["auth-session"];

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useQuery<AuthSession | null>({ queryKey: authKey, queryFn: apiClient.authMe,
    retry: false, staleTime: 60_000, refetchInterval: 60_000, refetchOnWindowFocus: true });

  const clearProtectedCache = () => {
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== authKey[0] });
  };

  useEffect(() => {
    const expired = () => {
      clearProtectedCache();
      queryClient.setQueryData(authKey, null);
    };
    window.addEventListener("bayt-auth-expired", expired);
    return () => window.removeEventListener("bayt-auth-expired", expired);
  }, [queryClient]);

  const login = async (user: string, password: string) => {
    const result = await apiClient.authLogin(user, password);
    clearProtectedCache();
    queryClient.setQueryData(authKey, result);
  };
  const logout = async () => {
    await apiClient.authLogout();
    clearProtectedCache();
    queryClient.setQueryData(authKey, null);
  };
  return <AuthContext.Provider value={{ session: session.isError ? null : session.data || null, loading: session.isPending,
    login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw Error("AuthProvider is required");
  return context;
}
