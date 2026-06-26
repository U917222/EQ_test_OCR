import { Dispatch, SetStateAction, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { lookupZipcode, mergeAutoTown } from "@/lib/zipcode";

export type GenderFormValue = "unspecified" | "male" | "female" | "other";

export type CandidateProfileFormValue = {
  name: string;
  testDate: string;
  gender: GenderFormValue;
  postalCode: string;
  prefecture: string;
  city: string;
  addressLine: string;
  memo: string;
};

type Props = {
  value: CandidateProfileFormValue;
  onChange: Dispatch<SetStateAction<CandidateProfileFormValue>>;
  disabled?: boolean;
};

export function CandidateProfileForm({ value, onChange, disabled = false }: Props) {
  const [looking, setLooking] = useState(false);
  const lastAutoTownRef = useRef<string>("");

  const update = (field: keyof CandidateProfileFormValue, nextValue: string) => {
    onChange((current) => ({ ...current, [field]: nextValue }));
  };

  const handleZipLookup = async () => {
    if (!value.postalCode.trim()) {
      toast.error("郵便番号を入力してください");
      return;
    }
    setLooking(true);
    try {
      const result = await lookupZipcode(value.postalCode);
      if (!result) {
        toast.error("住所が見つかりませんでした。郵便番号をご確認ください");
        return;
      }
      // 都道府県・市区町村は上書き、前回自動補完した町域だけを差し替える。
      const previousTown = lastAutoTownRef.current;
      lastAutoTownRef.current = result.town;
      onChange((current) => ({
        ...current,
        prefecture: result.prefecture,
        city: result.city,
        addressLine: mergeAutoTown(current.addressLine, previousTown, result.town),
      }));
    } finally {
      setLooking(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">氏名</Label>
        <Input
          id="name"
          value={value.name}
          onChange={(event) => update("name", event.target.value)}
          autoComplete="name"
          disabled={disabled}
          required
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="testDate">受験日</Label>
          <Input
            id="testDate"
            type="date"
            value={value.testDate}
            onChange={(event) => update("testDate", event.target.value)}
            disabled={disabled}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gender">性別</Label>
          <Select
            value={value.gender}
            onValueChange={(nextValue) => update("gender", nextValue)}
            disabled={disabled}
          >
            <SelectTrigger id="gender" aria-label="性別">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unspecified">未選択</SelectItem>
              <SelectItem value="male">男性</SelectItem>
              <SelectItem value="female">女性</SelectItem>
              <SelectItem value="other">その他</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="postalCode">郵便番号</Label>
        <div className="flex gap-2">
          <Input
            id="postalCode"
            value={value.postalCode}
            onChange={(event) => update("postalCode", event.target.value)}
            autoComplete="postal-code"
            inputMode="numeric"
            placeholder="9300094"
            disabled={disabled}
            className="max-w-[200px]"
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleZipLookup}
            disabled={disabled || looking}
            className="shrink-0"
          >
            {looking ? <Loader2 className="h-4 w-4 animate-spin" /> : "住所を自動入力"}
          </Button>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="prefecture">都道府県</Label>
          <Input
            id="prefecture"
            value={value.prefecture}
            onChange={(event) => update("prefecture", event.target.value)}
            autoComplete="address-level1"
            disabled={disabled}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="city">市区町村</Label>
          <Input
            id="city"
            value={value.city}
            onChange={(event) => update("city", event.target.value)}
            autoComplete="address-level2"
            disabled={disabled}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="addressLine">番地・建物名</Label>
        <Input
          id="addressLine"
          value={value.addressLine}
          onChange={(event) => update("addressLine", event.target.value)}
          autoComplete="street-address"
          disabled={disabled}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="memo">メモ</Label>
        <Textarea
          id="memo"
          value={value.memo}
          onChange={(event) => update("memo", event.target.value)}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
