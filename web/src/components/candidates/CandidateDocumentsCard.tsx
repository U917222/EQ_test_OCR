import { FormEvent, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FileText, FileUp, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isApiError, postApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { newOperationId } from "@/lib/operation";
import type {
  CandidateDocument,
  CandidateDocumentCategory,
  DeleteCandidateDocumentPayload,
  ListCandidateDocumentsResponse,
  UploadCandidateDocumentPayload,
} from "@/lib/types";
import { MAX_ORIGINAL_UPLOAD_BYTES, prepareUploadFile } from "@/lib/upload";

const CATEGORY_LABELS: Record<CandidateDocumentCategory, string> = {
  resume: "履歴書",
  essay: "作文",
  other: "その他",
};

export function CandidateDocumentsCard({ candidateId }: { candidateId: string }) {
  const { can } = useAuth();
  const canOperate = can("operator");
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [category, setCategory] = useState<CandidateDocumentCategory>("resume");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadOperationId, setUploadOperationId] = useState<string | null>(null);
  const [previewDocument, setPreviewDocument] = useState<CandidateDocument | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CandidateDocument | null>(null);
  const [deleteOperationId, setDeleteOperationId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["candidateDocuments", candidateId],
    queryFn: () =>
      postApi<{ candidateId: string }, ListCandidateDocumentsResponse>("listCandidateDocuments", { candidateId }),
    enabled: Boolean(candidateId),
  });

  const uploadMutation = useMutation({
    mutationFn: async ({
      file,
      documentCategory,
      operationId,
    }: {
      file: File;
      documentCategory: CandidateDocumentCategory;
      operationId: string;
    }) => {
      const payload: UploadCandidateDocumentPayload = {
        candidateId,
        category: documentCategory,
        file: await prepareUploadFile(file),
        operationId,
      };
      return postApi<UploadCandidateDocumentPayload, { document: CandidateDocument }>(
        "uploadCandidateDocument",
        payload,
      );
    },
    onSuccess: () => {
      toast.success("参考資料を追加しました");
      closeUploadDialog();
      queryClient.invalidateQueries({ queryKey: ["candidateDocuments", candidateId] });
    },
    onError: (error) => {
      toast.error(isApiError(error) ? error.message : "参考資料をアップロードできませんでした");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ document, operationId }: { document: CandidateDocument; operationId: string }) => {
      const payload: DeleteCandidateDocumentPayload = {
        candidateId,
        documentId: document.documentId,
        operationId,
      };
      return postApi<DeleteCandidateDocumentPayload, { deleted: boolean }>("deleteCandidateDocument", payload);
    },
    onSuccess: (_, { document: deletedDocument }) => {
      toast.success("参考資料を削除しました");
      closeDeleteDialog();
      if (previewDocument?.documentId === deletedDocument.documentId) setPreviewDocument(null);
      queryClient.invalidateQueries({ queryKey: ["candidateDocuments", candidateId] });
    },
    onError: (error) => {
      toast.error(isApiError(error) ? error.message : "参考資料を削除できませんでした");
    },
  });

  const documents = query.data?.documents ?? [];

  const selectFile = (file?: File) => {
    setSelectedFile(null);
    setUploadOperationId(null);
    if (!file) return;
    if (file.type !== "application/pdf") {
      toast.error("PDFのみ選択できます");
      return;
    }
    if (file.size > MAX_ORIGINAL_UPLOAD_BYTES) {
      toast.error("PDFは9MB以下にしてください");
      return;
    }
    setSelectedFile(file);
    setUploadOperationId(newOperationId());
  };

  const selectCategory = (value: CandidateDocumentCategory) => {
    setCategory(value);
    if (selectedFile) setUploadOperationId(newOperationId());
  };

  const submitUpload = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedFile) {
      toast.error("PDFを選択してください");
      return;
    }
    const operationId = uploadOperationId ?? newOperationId();
    if (!uploadOperationId) setUploadOperationId(operationId);
    uploadMutation.mutate({ file: selectedFile, documentCategory: category, operationId });
  };

  const closeUploadDialog = () => {
    setUploadOpen(false);
    setSelectedFile(null);
    setUploadOperationId(null);
    setCategory("resume");
    if (inputRef.current) inputRef.current.value = "";
  };

  const openDeleteDialog = (document: CandidateDocument) => {
    setPendingDelete(document);
    setDeleteOperationId(newOperationId());
  };

  const closeDeleteDialog = () => {
    setPendingDelete(null);
    setDeleteOperationId(null);
  };

  const submitDelete = () => {
    if (!pendingDelete) return;
    const operationId = deleteOperationId ?? newOperationId();
    if (!deleteOperationId) setDeleteOperationId(operationId);
    deleteMutation.mutate({ document: pendingDelete, operationId });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>参考資料</CardTitle>
          <CardDescription>履歴書・作文・その他のPDFを保管します。採点には使用されません。</CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => setUploadOpen(true)}
          disabled={!canOperate}
          title={!canOperate ? "operator以上のみ追加できます" : undefined}
        >
          <Plus className="h-4 w-4" />
          PDFを追加
        </Button>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            参考資料を読み込んでいます
          </div>
        ) : query.isError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            参考資料を取得できませんでした。時間をおいて再読み込みしてください。
          </div>
        ) : documents.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <FileText className="mx-auto h-8 w-8 text-slate-400" />
            <p className="mt-3 text-sm text-slate-600">参考資料はまだありません。</p>
            {canOperate ? (
              <Button type="button" variant="outline" className="mt-4" onClick={() => setUploadOpen(true)}>
                <FileUp className="h-4 w-4" />
                最初のPDFを追加
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {documents.map((document) => (
              <div
                key={document.documentId}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant={categoryVariant(document.category)}>{CATEGORY_LABELS[document.category]}</Badge>
                    <span className="truncate font-medium text-slate-900" title={document.filename}>
                      {document.filename}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {formatFileSize(document.sizeBytes)}
                    {document.uploadedAt ? ` / ${formatUploadedAt(document.uploadedAt)}` : ""}
                    {document.uploadedBy ? ` / ${document.uploadedBy}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setPreviewDocument(document)}>
                    <FileText className="h-4 w-4" />
                    プレビュー
                  </Button>
                  {canOperate ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => openDeleteDialog(document)}
                      aria-label={`${document.filename}を削除`}
                    >
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog
        open={uploadOpen}
        onOpenChange={(open) => open
          ? setUploadOpen(true)
          : !uploadMutation.isPending && closeUploadDialog()}
      >
        <DialogContent>
          <form onSubmit={submitUpload}>
            <DialogHeader>
              <DialogTitle>参考資料のPDFを追加</DialogTitle>
              <DialogDescription>資料の種類を選び、9MB以下のPDFをアップロードしてください。</DialogDescription>
            </DialogHeader>
            <div className="my-5 space-y-5">
              <div className="space-y-2">
                <Label htmlFor="candidate-document-category">資料の種類</Label>
                <Select
                  value={category}
                  onValueChange={(value) => selectCategory(value as CandidateDocumentCategory)}
                  disabled={uploadMutation.isPending}
                >
                  <SelectTrigger id="candidate-document-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="resume">履歴書</SelectItem>
                    <SelectItem value="essay">作文</SelectItem>
                    <SelectItem value="other">その他</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="candidate-document-file">PDFファイル</Label>
                <Input
                  ref={inputRef}
                  id="candidate-document-file"
                  type="file"
                  accept="application/pdf,.pdf"
                  disabled={uploadMutation.isPending}
                  onChange={(event) => selectFile(event.target.files?.[0])}
                />
                {selectedFile ? (
                  <p className="text-sm text-slate-600">
                    {selectedFile.name}（{formatFileSize(selectedFile.size)}）
                  </p>
                ) : null}
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeUploadDialog} disabled={uploadMutation.isPending}>
                キャンセル
              </Button>
              <Button type="submit" disabled={!selectedFile || uploadMutation.isPending}>
                {uploadMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
                アップロード
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(previewDocument)} onOpenChange={(open) => !open && setPreviewDocument(null)}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>{previewDocument?.filename ?? "参考資料"}</DialogTitle>
            <DialogDescription>
              {previewDocument ? CATEGORY_LABELS[previewDocument.category] : "PDFプレビュー"}
            </DialogDescription>
          </DialogHeader>
          {previewDocument ? (
            <iframe
              src={previewDocument.url}
              title={`${previewDocument.filename}のプレビュー`}
              className="h-[70vh] w-full rounded-lg border bg-slate-100"
            />
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPreviewDocument(null)}>
              閉じる
            </Button>
            {previewDocument ? (
              <Button asChild>
                <a href={previewDocument.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  新しいタブで開く
                </a>
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && !deleteMutation.isPending && closeDeleteDialog()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>参考資料を削除しますか？</DialogTitle>
            <DialogDescription>
              {pendingDelete ? `「${pendingDelete.filename}」を削除します。この操作は取り消せません。` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDeleteDialog} disabled={deleteMutation.isPending}>
              キャンセル
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={submitDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              削除する
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function categoryVariant(category: CandidateDocumentCategory): "info" | "warning" | "neutral" {
  if (category === "resume") return "info";
  if (category === "essay") return "warning";
  return "neutral";
}

function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "0 KB";
  if (sizeBytes < 1024 * 1024) return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatUploadedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
