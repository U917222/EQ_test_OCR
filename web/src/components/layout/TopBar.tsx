import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";

export function TopBar({ onOpenMobile }: { onOpenMobile: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-white/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMobile} aria-label="メニューを開く">
        <Menu className="h-5 w-5" />
      </Button>
    </header>
  );
}
