import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { FormEvent, lazy, Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuth } from "@/lib/auth";
import { isApiError, rememberSharedPassword } from "@/lib/api";

const CandidatesPage = lazy(() => import("@/pages/CandidatesPage"));
const CandidateNewPage = lazy(() => import("@/pages/CandidateNewPage"));
const DashboardPage = lazy(() => import("@/pages/DashboardPage"));
const ReviewPage = lazy(() => import("@/pages/ReviewPage"));
const ResultPage = lazy(() => import("@/pages/ResultPage"));
const EvaluationFormPage = lazy(() => import("@/pages/EvaluationFormPage"));

function CandidateIndexRedirect() {
  const { id } = useParams();
  return <Navigate to={`/candidates/${id}/result`} replace />;
}

function AuthGate() {
  const { error, reload } = useAuth();
  const [password, setPassword] = useState("");

  const submitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextPassword = password.trim();
    if (!nextPassword) return;
    rememberSharedPassword(nextPassword);
    document.cookie = "cheq_app_password=; Path=/; Max-Age=0; SameSite=Strict; Secure";
    document.cookie = `cheq_app_password=${encodeURIComponent(nextPassword)}; Path=/; SameSite=Strict; Secure`;
    reload();
  };

  if (isApiError(error) && error.status === 401) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-md rounded-lg border bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-950">パスワードを入力</h1>
          <p className="mt-2 text-sm text-slate-600">共有パスワードでログインします。</p>
          <form className="mt-6 space-y-4" onSubmit={submitPassword}>
            <Input
              type="password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="パスワード"
              autoComplete="current-password"
            />
            <Button type="submit" className="w-full">
              入る
            </Button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-50 p-6 text-sm text-slate-600">読み込み中</div>}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="candidates" element={<CandidatesPage />} />
          <Route path="candidates/new" element={<CandidateNewPage />} />
          <Route path="candidates/:id" element={<CandidateIndexRedirect />} />
          <Route path="candidates/:id/review" element={<ReviewPage />} />
          <Route path="candidates/:id/result" element={<ResultPage />} />
          <Route path="candidates/:id/evaluation/new" element={<EvaluationFormPage />} />
          <Route path="candidates/:id/evaluation/:evaluationId/edit" element={<EvaluationFormPage />} />
          <Route path="review" element={<Navigate to="/candidates?status=needs_review" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return <AuthGate />;
}
