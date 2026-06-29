import { useMemo, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { cn } from "@/lib/utils";

function breadcrumb(pathname: string) {
  if (pathname === "/" || pathname === "/dashboard") return ["ダッシュボード"];
  if (pathname === "/candidates") return ["候補者"];
  if (pathname === "/candidates/new") return ["候補者", "新規登録"];
  if (pathname.endsWith("/review")) return ["候補者", "レビュー"];
  if (pathname.endsWith("/result")) return ["候補者", "結果"];
  return ["CHEQ"];
}

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const crumbs = useMemo(() => breadcrumb(location.pathname), [location.pathname]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <div className="flex">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((current) => !current)} />
        <div
          className={cn(
            "fixed inset-0 z-40 bg-slate-950/30 lg:hidden",
            mobileOpen ? "block" : "hidden",
          )}
          onClick={() => setMobileOpen(false)}
        />
        <div
          className={cn(
            "fixed inset-y-0 left-0 z-50 w-72 border-r bg-white p-3 transition-transform lg:hidden",
            mobileOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="mb-3 flex h-10 items-center justify-between px-2">
            <div>
              <div className="text-sm font-semibold">CHEQ</div>
              <div className="text-xs text-slate-500">採点支援</div>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="メニューを閉じる">
              <X className="h-5 w-5" />
            </Button>
          </div>
          <nav className="space-y-1" aria-label="モバイルナビゲーション">
            {[
              ["/dashboard", "ダッシュボード"],
              ["/candidates", "候補者"],
              ["/review", "レビュー"],
            ].map(([to, label]) => (
              <Link
                key={to}
                to={to}
                className="block rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                onClick={() => setMobileOpen(false)}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="min-w-0 flex-1">
          <TopBar onOpenMobile={() => setMobileOpen(true)} />
          <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            <nav className="mb-5 flex items-center gap-2 text-sm text-slate-500" aria-label="パンくず">
              {crumbs.map((crumb, index) => (
                <span key={`${crumb}-${index}`} className={index === crumbs.length - 1 ? "text-slate-900" : ""}>
                  {crumb}
                  {index < crumbs.length - 1 ? <span className="ml-2 text-slate-400">/</span> : null}
                </span>
              ))}
            </nav>
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
