import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CandidateProfileForm, CandidateProfileFormValue, GenderFormValue } from "@/components/candidates/CandidateProfileForm";
import { isApiError, postApi } from "@/lib/api";
import { normalizeGetResultResponse } from "@/lib/api-normalizers";
import { newOperationId } from "@/lib/operation";
import { Candidate, GetResultResponse, UpdateCandidatePayload } from "@/lib/types";

const emptyForm: CandidateProfileFormValue = {
  name: "",
  testDate: "",
  gender: "unspecified",
  postalCode: "",
  prefecture: "",
  city: "",
  addressLine: "",
  memo: "",
};

export default function CandidateEditPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CandidateProfileFormValue>(emptyForm);

  const query = useQuery({
    queryKey: ["result", id],
    queryFn: async () =>
      normalizeGetResultResponse(await postApi<{ candidateId: string }, unknown>("getResult", { candidateId: id })),
    enabled: Boolean(id),
  });

  useEffect(() => {
    if (query.error) toast.error("候補者情報を取得できませんでした");
  }, [query.error]);

  useEffect(() => {
    if (!query.data?.candidate) return;
    setForm(formFromCandidate(query.data.candidate));
  }, [query.data?.candidate]);

  const mutation = useMutation({
    mutationFn: (payload: UpdateCandidatePayload) =>
      postApi<UpdateCandidatePayload, { candidate: Candidate }>("updateCandidate", payload),
    onSuccess: ({ candidate }) => {
      toast.success("候補者情報を更新しました");
      queryClient.setQueryData<GetResultResponse>(["result", id], (current) =>
        current ? { ...current, candidate } : current,
      );
      queryClient.invalidateQueries({ queryKey: ["result", id] });
      queryClient.invalidateQueries({ queryKey: ["candidates"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      navigate(`/candidates/${id}/result`);
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : "候補者情報を更新できませんでした"),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.name.trim() || !form.testDate) {
      toast.error("氏名と受験日を入力してください");
      return;
    }
    mutation.mutate({
      candidateId: id,
      name: form.name,
      testDate: form.testDate,
      gender: form.gender === "unspecified" ? undefined : form.gender,
      postalCode: form.postalCode || undefined,
      prefecture: form.prefecture || undefined,
      city: form.city || undefined,
      addressLine: form.addressLine || undefined,
      memo: form.memo || undefined,
      operationId: newOperationId(),
    });
  };

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-[520px]" />
      </div>
    );
  }

  if (!query.data?.candidate) {
    return (
      <Card>
        <CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
          <h1 className="text-lg font-semibold">候補者情報を取得できませんでした</h1>
          <Button asChild className="mt-5" variant="outline">
            <Link to="/candidates">候補者一覧へ</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <form className="mx-auto max-w-3xl space-y-6" onSubmit={onSubmit}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">候補者情報を編集</h1>
          <p className="mt-1 text-sm text-slate-600">氏名、受験日、性別、住所、メモを更新します。</p>
        </div>
        <Button asChild variant="outline">
          <Link to={`/candidates/${id}/result`}>
            <ArrowLeft className="h-4 w-4" />
            戻る
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>候補者情報</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <CandidateProfileForm value={form} onChange={setForm} disabled={mutation.isPending} />
          <div className="flex justify-end gap-2">
            <Button asChild variant="outline" disabled={mutation.isPending}>
              <Link to={`/candidates/${id}/result`}>キャンセル</Link>
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

function formFromCandidate(candidate: Candidate): CandidateProfileFormValue {
  return {
    name: candidate.name ?? "",
    testDate: candidate.testDate ?? "",
    gender: toGenderFormValue(candidate.gender),
    postalCode: candidate.postalCode ?? "",
    prefecture: candidate.prefecture ?? "",
    city: candidate.city ?? "",
    addressLine: candidate.addressLine ?? "",
    memo: candidate.memo ?? "",
  };
}

function toGenderFormValue(value: Candidate["gender"]): GenderFormValue {
  if (value === "male" || value === "female" || value === "other") return value;
  return "unspecified";
}
