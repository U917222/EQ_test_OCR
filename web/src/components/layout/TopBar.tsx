import { Menu, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function TopBar({ onOpenMobile }: { onOpenMobile: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-white/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMobile} aria-label="メニューを開く">
        <Menu className="h-5 w-5" />
      </Button>
      <div className="relative max-w-md flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input className="pl-9" placeholder="候補者名・IDを検索" aria-label="候補者名・IDを検索" />
      </div>
    </header>
  );
}
