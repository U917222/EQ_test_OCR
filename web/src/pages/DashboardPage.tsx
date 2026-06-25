import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertCircle, CheckCircle2, Clock3, FileText, TrendingUp, Users } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { postApi } from "@/lib/api";
import { statusLabels } from "@/lib/labels";
import { CandidateStatus, DashboardResponse } from "@/lib/types";
import { cn, formatDate, formatDateTime } from "@/lib/utils";

const COLORS = {
  blue: "#0017C1",
  orange: "#FB5B01",
  green: "#115A36",
  cyan: "#006F83",
  red: "#CE0000",
  gray: "#767676",
  grid: "rgba(204,204,204,0.45)",
};

const STATUS_COLORS: Record<string, string> = {
  uploaded: COLORS.gray,
  recognizing: COLORS.cyan,
  needs_review: COLORS.orange,
  scored: COLORS.blue,
  finalized: COLORS.green,
};

type TooltipPayload = {
  name?: string;
  value?: number;
  color?: string;
};

type TooltipProps = {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
};

export default function DashboardPage() {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(String(currentYear));

  const query = useQuery({
    queryKey: ["dashboard", selectedYear],
    queryFn: () => postApi<{ year: number }, DashboardResponse>("getDashboard", { year: Number(selectedYear) }),
  });

  useEffect(() => {
    if (query.error) toast.error("ダッシュボードの集計データを取得できませんでした");
  }, [query.error]);

  useEffect(() => {
    if (query.data && selectedYear !== String(query.data.year)) {
      setSelectedYear(String(query.data.year));
    }
  }, [query.data, selectedYear]);

  const dashboard = query.data;
  const availableYears = dashboard?.availableYears.length ? dashboard.availableYears : [currentYear];

  const statusData = useMemo(
    () =>
      (dashboard?.statusBreakdown ?? [])
        .map((entry) => ({
          ...entry,
          label: statusLabel(entry.status),
          color: STATUS_COLORS[String(entry.status)] ?? COLORS.gray,
        }))
        .sort((a, b) => b.value - a.value),
    [dashboard],
  );

  const decisionData = useMemo(
    () =>
      (dashboard?.decisionBreakdown ?? []).map((entry) => ({
        ...entry,
        color: entry.label === "合格" ? COLORS.green : entry.label === "不合格" ? COLORS.red : COLORS.gray,
      })),
    [dashboard],
  );

  const rankData = useMemo(
    () =>
      (dashboard?.rankBreakdown ?? []).map((entry) => ({
        label: `${entry.rank}ランク`,
        value: entry.value,
        color: rankColor(entry.rank),
      })),
    [dashboard],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">応募者分析ダッシュボード</h1>
          <p className="mt-1 text-sm text-slate-600">
            DBの候補者・判定結果・レビュー状況を年次で集計します。
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="text-xs text-slate-500">データ更新日: {dashboard?.updatedAt ? formatDateTime(dashboard.updatedAt) : "-"}</div>
          <Select value={selectedYear} onValueChange={setSelectedYear}>
            <SelectTrigger className="w-36" aria-label="集計年">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableYears.map((year) => (
                <SelectItem key={year} value={String(year)}>
                  {year}年
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {query.isLoading || !dashboard ? (
        <LoadingState />
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="主要指標">
            <KpiCard
              label="年間応募者数"
              value={`${dashboard.summary.total.toLocaleString()}人`}
              detail={previousYearText(dashboard)}
              icon={Users}
              tone="blue"
            />
            <KpiCard
              label="合格率"
              value={`${dashboard.summary.passRate}%`}
              detail={`判定済み ${dashboard.summary.decided.toLocaleString()}人 / 合格 ${dashboard.summary.hired.toLocaleString()}人`}
              icon={TrendingUp}
              tone="green"
            />
            <KpiCard
              label="未解決レビュー"
              value={`${dashboard.summary.openReviews.toLocaleString()}件`}
              detail={`レビュー待ち候補者 ${dashboard.summary.needsReview.toLocaleString()}人`}
              icon={Clock3}
              tone="orange"
            />
            <KpiCard
              label="要注意候補者"
              value={`${dashboard.summary.lowRequirementCandidates.toLocaleString()}人`}
              detail={dashboard.summary.averageAttitudeStage === null ? "応答態度データなし" : `平均応答態度 ${dashboard.summary.averageAttitudeStage}`}
              icon={AlertCircle}
              tone="red"
            />
          </section>

          <section className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
            <Card className="rounded-md">
              <CardHeader className="pb-3">
                <CardTitle>月別応募者数・男女別内訳（{dashboard.year}年、単位: 人）</CardTitle>
                <p className="text-sm text-slate-600">DBの `candidates.test_date` と `candidates.gender` を集計</p>
              </CardHeader>
              <CardContent>
                <div
                  className="h-[360px]"
                  role="img"
                  aria-label={`${dashboard.year}年の月別応募者数。年間合計は${dashboard.summary.total}人です。`}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={dashboard.monthly} margin={{ top: 10, right: 16, left: -18, bottom: 0 }}>
                      <CartesianGrid stroke={COLORS.grid} vertical={false} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                      <Tooltip content={<ChartTooltip />} />
                      <Legend iconSize={10} />
                      <Bar dataKey="male" name="男性" stackId="gender" fill={COLORS.blue} />
                      <Bar dataKey="female" name="女性" stackId="gender" fill={COLORS.orange} />
                      <Bar dataKey="other" name="その他" stackId="gender" fill={COLORS.green} />
                      <Bar dataKey="unknown" name="未設定" stackId="gender" fill={COLORS.gray} />
                      <Line type="monotone" dataKey="total" name="合計" stroke={COLORS.red} strokeWidth={2} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-md">
              <CardHeader className="pb-3">
                <CardTitle>処理ステータス（{dashboard.year}年、単位: 人）</CardTitle>
                <p className="text-sm text-slate-600">DBの `candidates.status` を集計</p>
              </CardHeader>
              <CardContent>
                <div className="h-[360px]" role="img" aria-label={`${dashboard.year}年の処理ステータス別件数。`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={statusData} layout="vertical" margin={{ top: 4, right: 16, left: 34, bottom: 4 }}>
                      <CartesianGrid stroke={COLORS.grid} horizontal={false} />
                      <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
                      <YAxis type="category" dataKey="label" width={88} tickLine={false} axisLine={false} />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar dataKey="value" name="件数" radius={[0, 4, 4, 0]}>
                        {statusData.map((entry) => (
                          <Cell key={entry.status} fill={entry.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </section>

          <section className="grid gap-4 xl:grid-cols-3">
            <Card className="rounded-md">
              <CardHeader className="pb-3">
                <CardTitle>判定内訳（{dashboard.year}年、単位: 人）</CardTitle>
                <p className="text-sm text-slate-600">DBの `hiring_decision` を集計</p>
              </CardHeader>
              <CardContent>
                <PiePanel data={decisionData} ariaLabel={`${dashboard.year}年の判定内訳。合格率は${dashboard.summary.passRate}%です。`} />
              </CardContent>
            </Card>

            <Card className="rounded-md">
              <CardHeader className="pb-3">
                <CardTitle>総合ランク内訳（{dashboard.year}年、単位: 人）</CardTitle>
                <p className="text-sm text-slate-600">DBの `results.total_rank` を集計</p>
              </CardHeader>
              <CardContent>
                <PiePanel data={rankData} ariaLabel={`${dashboard.year}年の総合ランク内訳。`} />
              </CardContent>
            </Card>

            <Card className="rounded-md">
              <CardHeader className="pb-3">
                <CardTitle>地域別応募者数（{dashboard.year}年、単位: 人）</CardTitle>
                <p className="text-sm text-slate-600">DBの `candidates.prefecture` / `city`（富山県のみ市町村別、上位10区分）</p>
              </CardHeader>
              <CardContent>
                <div className="h-[260px]" role="img" aria-label={`${dashboard.year}年の地域別応募者数。富山県は市町村別。`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dashboard.regionBreakdown} margin={{ top: 4, right: 16, left: -18, bottom: 40 }}>
                      <CartesianGrid stroke={COLORS.grid} vertical={false} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} angle={-30} textAnchor="end" height={56} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar dataKey="value" name="応募者数" fill={COLORS.cyan} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </section>

          <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Card className="rounded-md">
              <CardHeader className="pb-3">
                <CardTitle>要注意項目（{dashboard.year}年、単位: 件）</CardTitle>
                <p className="text-sm text-slate-600">DBの `results.job_requirement_low_items_json` を集計</p>
              </CardHeader>
              <CardContent>
                {dashboard.attentionItems.length ? (
                  <div className="h-[280px]" role="img" aria-label={`${dashboard.year}年の要注意項目件数。`}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dashboard.attentionItems} layout="vertical" margin={{ top: 4, right: 16, left: 86, bottom: 4 }}>
                        <CartesianGrid stroke={COLORS.grid} horizontal={false} />
                        <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
                        <YAxis type="category" dataKey="label" width={138} tickLine={false} axisLine={false} />
                        <Tooltip content={<ChartTooltip unit="件" />} />
                        <Bar dataKey="value" name="件数" fill={COLORS.orange} radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyPanel message="要注意項目はありません" />
                )}
              </CardContent>
            </Card>

            <Card className="rounded-md">
              <CardHeader className="pb-3">
                <CardTitle>直近応募者（{dashboard.year}年）</CardTitle>
                <p className="text-sm text-slate-600">DBから取得した最新10件</p>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>氏名</TableHead>
                      <TableHead>受験日</TableHead>
                      <TableHead>ステータス</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dashboard.recent.map((candidate) => (
                      <TableRow key={candidate.candidateId}>
                        <TableCell className="font-medium">{candidate.name}</TableCell>
                        <TableCell>{formatDate(candidate.testDate)}</TableCell>
                        <TableCell>{statusLabel(candidate.status)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </section>

          {dashboard.summary.genderUnknown > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              <span>
                男女別内訳は DB の `candidates.gender` を使っています。未登録の {dashboard.summary.genderUnknown.toLocaleString()}
                人は「未設定」に集計しています。
              </span>
            </div>
          )}

          <Card className="rounded-md">
            <CardHeader className="pb-3">
              <CardTitle>月次集計テーブル（{dashboard.year}年、単位: 人）</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>月</TableHead>
                      <TableHead className="text-right">合計</TableHead>
                      <TableHead className="text-right">男性</TableHead>
                      <TableHead className="text-right">女性</TableHead>
                      <TableHead className="text-right">その他</TableHead>
                      <TableHead className="text-right">未設定</TableHead>
                      <TableHead className="text-right">レビュー待ち</TableHead>
                      <TableHead className="text-right">確定済み</TableHead>
                      <TableHead className="text-right">合格</TableHead>
                      <TableHead className="text-right">合格率</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dashboard.monthly.map((row) => (
                      <TableRow key={row.month}>
                        <TableCell className="font-medium">{row.label}</TableCell>
                        <NumberCell value={row.total} />
                        <NumberCell value={row.male} />
                        <NumberCell value={row.female} />
                        <NumberCell value={row.other} />
                        <NumberCell value={row.unknown} />
                        <NumberCell value={row.needsReview} />
                        <NumberCell value={row.finalized} />
                        <NumberCell value={row.hired} />
                        <TableCell className="text-right tabular-nums">{row.passRate}%</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <footer className="text-xs text-slate-500">
            データソース: {dashboard.dataSource} / 集計生成日時: {formatDateTime(dashboard.generatedAt)} / データ更新日:{" "}
            {dashboard.updatedAt ? formatDateTime(dashboard.updatedAt) : "-"}
          </footer>
        </>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Users;
  tone: "blue" | "green" | "orange" | "red";
}) {
  const toneClass = {
    blue: "bg-blue-50 text-blue-700",
    green: "bg-emerald-50 text-emerald-700",
    orange: "bg-orange-50 text-orange-700",
    red: "bg-red-50 text-red-700",
  }[tone];

  return (
    <Card className="rounded-md">
      <CardContent className="flex items-start justify-between gap-4 p-5">
        <div className="min-w-0">
          <p className="text-sm text-slate-600">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-normal text-slate-950">{value}</p>
          <p className="mt-2 text-xs text-slate-500">{detail}</p>
        </div>
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-md", toneClass)}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
      </CardContent>
    </Card>
  );
}

function PiePanel({ data, ariaLabel }: { data: Array<{ label: string; value: number; color: string }>; ariaLabel: string }) {
  const hasData = data.some((entry) => entry.value > 0);
  if (!hasData) return <EmptyPanel message="集計対象データがありません" />;
  return (
    <div className="h-[260px]" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip content={<ChartTooltip />} />
          <Legend iconSize={10} />
          <Pie data={data} dataKey="value" nameKey="label" innerRadius={56} outerRadius={88} paddingAngle={2}>
            {data.map((entry) => (
              <Cell key={entry.label} fill={entry.color} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartTooltip({ active, payload, label, unit = "人" }: TooltipProps & { unit?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border bg-white px-3 py-2 text-sm shadow-sm">
      {label && <div className="mb-1 font-medium text-slate-900">{label}</div>}
      <div className="space-y-1">
        {payload.map((item) => (
          <div key={`${item.name}-${item.color}`} className="flex items-center justify-between gap-6">
            <span className="flex items-center gap-2 text-slate-600">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color ?? COLORS.gray }} />
              {item.name}
            </span>
            <span className="font-medium text-slate-900">
              {Number(item.value ?? 0).toLocaleString()}
              {unit}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NumberCell({ value }: { value: number }) {
  return <TableCell className="text-right tabular-nums">{value.toLocaleString()}</TableCell>;
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="flex h-[260px] items-center justify-center rounded-md border border-dashed bg-slate-50 text-sm text-slate-500">
      {message}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-32 rounded-md" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Skeleton className="h-[440px] rounded-md" />
        <Skeleton className="h-[440px] rounded-md" />
      </div>
    </div>
  );
}

function statusLabel(status: CandidateStatus | string) {
  return statusLabels[status as CandidateStatus] ?? String(status || "未設定");
}

function rankColor(rank: string) {
  switch (rank) {
    case "A":
      return COLORS.green;
    case "B":
      return COLORS.blue;
    case "C":
      return COLORS.orange;
    case "D":
      return COLORS.red;
    default:
      return COLORS.gray;
  }
}

function previousYearText(dashboard: DashboardResponse) {
  const { previousYearTotal, previousYearDiff, previousYearRate } = dashboard.summary;
  if (!previousYearTotal || previousYearRate === null) return "前年データなし";
  const sign = previousYearDiff > 0 ? "+" : "";
  return `前年比 ${sign}${previousYearRate}%（${sign}${previousYearDiff.toLocaleString()}人）`;
}
