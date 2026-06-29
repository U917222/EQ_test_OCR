import { NavLink } from "react-router-dom";
import { BarChart3, PanelLeftClose, PanelLeftOpen, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const items: Array<{
  to: string;
  label: string;
  icon: typeof Users;
  end?: boolean;
}> = [
  { to: "/dashboard", label: "ダッシュボード", icon: BarChart3 },
  { to: "/candidates", label: "候補者", icon: Users },
];

export function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <aside
      className={cn(
        "hidden border-r bg-white transition-[width] duration-200 lg:flex lg:min-h-screen lg:flex-col",
        collapsed ? "lg:w-20" : "lg:w-64",
      )}
    >
      <div className="flex h-16 items-center justify-between border-b px-4">
        <div className={cn("min-w-0", collapsed && "sr-only")}>
          <div className="text-sm font-semibold text-slate-950">CHEQ</div>
          <div className="text-xs text-slate-500">採点支援</div>
        </div>
        <Button variant="ghost" size="icon" onClick={onToggle} aria-label="サイドバーを折りたたむ">
          {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
        </Button>
      </div>
      <nav className="flex-1 space-y-1 p-3" aria-label="主要ナビゲーション">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-ring",
                isActive && "bg-indigo-50 text-indigo-700",
                collapsed && "justify-center px-0",
              )
            }
            title={collapsed ? item.label : undefined}
          >
            <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className={cn(collapsed && "sr-only")}>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
