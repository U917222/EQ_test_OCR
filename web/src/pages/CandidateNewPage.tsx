import { DragEvent, FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CandidateProfileForm, CandidateProfileFormValue } from "@/components/candidates/CandidateProfileForm";
import { isApiError, postApi } from "@/lib/api";
import { newOperationId } from "@/lib/operation";
import { Candidate, RegisterCandidatePayload } from "@/lib/types";
import { prepareUploadFile, UploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";

export default function CandidateNewPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [form, setForm] = useState<CandidateProfileFormValue>({
    name: "",
    testDate: "",
    gender: "unspecified",
    postalCode: "",
    prefecture: "",
    city: "",
    addressLine: "",
    memo: "",
  });

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const mutation = useMutation({
    mutationFn: async (payload: RegisterCandidatePayload) =>
      postApi<RegisterCandidatePayload, { candidate: Candidate }>("registerCandidate", payload),
    onSuccess: ({ candidate }) => {
      toast.success("候補者を登録しました");
      navigate(`/candidates/${candidate.candidateId}/result`);
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : "候補者を登録できませんでした"),
  });

  const acceptFile = (candidateFile?: File) => {
    if (!candidateFile) return;
    if (!candidateFile.type.startsWith("image/") && candidateFile.type !== "application/pdf") {
      toast.error("画像またはPDFを選択してください");
      return;
    }
    setFile(candidateFile);
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    acceptFile(event.dataTransfer.files[0]);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.name || !form.testDate) {
      toast.error("氏名と受験日を入力してください");
      return;
    }

    const payload: RegisterCandidatePayload = {
      name: form.name,
      testDate: form.testDate,
      gender: form.gender === "unspecified" ? undefined : form.gender,
      postalCode: form.postalCode || undefined,
      prefecture: form.prefecture || undefined,
      city: form.city || undefined,
      addressLine: form.addressLine || undefined,
      memo: form.memo || undefined,
      operationId: newOperationId(),
    };

    if (file) {
      let uploadFile: UploadFile;
      try {
        uploadFile = await prepareUploadFile(file);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "ファイルを処理できませんでした");
        return;
      }
      payload.file = uploadFile;
    }

    mutation.mutate(payload);
  };

  return (
    <form className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]" onSubmit={onSubmit}>
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">候補者を登録</h1>
          <p className="mt-1 text-sm text-slate-600">
            採点用紙は任意です。画像またはPDFは登録後にもアップロードできます。
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>採点用紙（任意）</CardTitle>
            <CardDescription>ドラッグ&ドロップ、またはファイル選択で登録します。後から追加もできます。</CardDescription>
          </CardHeader>
          <CardContent>
            <Label
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              className={cn(
                "flex min-h-72 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed bg-slate-50 p-6 text-center transition-colors",
                isDragging && "border-indigo-500 bg-indigo-50",
              )}
            >
              {previewUrl && file?.type.startsWith("image/") ? (
                <img src={previewUrl} alt="採点用紙プレビュー" className="max-h-80 rounded-lg object-contain" />
              ) : previewUrl && file?.type === "application/pdf" ? (
                <div className="rounded-lg border bg-white p-4 text-sm text-slate-700">{file.name}</div>
              ) : (
                <>
                  <FileUp className="h-12 w-12 text-slate-400" />
                  <span className="mt-4 text-sm font-medium text-slate-800">任意で画像/PDFをここにドロップ</span>
                  <span className="mt-1 text-sm text-slate-500">PNG, JPEG, PDF</span>
                </>
              )}
              <Input
                type="file"
                accept="image/*,application/pdf"
                className="sr-only"
                onChange={(event) => acceptFile(event.target.files?.[0])}
              />
            </Label>
          </CardContent>
        </Card>
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>候補者情報</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <CandidateProfileForm value={form} onChange={setForm} disabled={mutation.isPending} />
          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
            登録して結果へ
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}
