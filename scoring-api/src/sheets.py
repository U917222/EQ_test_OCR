"""Small Google Sheets API v4 wrapper."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Iterable

import google.auth
from googleapiclient.discovery import build


SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

# ADC 認証はプロセス内で一度だけ取得して使い回す（トークンも内部で自動更新される）。
# 毎リクエストごとの認証取得・サービス構築が数秒の固定オーバーヘッドになっていたため。
_credentials = None
_credentials_lock = threading.Lock()
# Sheets サービスはスレッドローカルで保持する。googleapiclient の HTTP は
# スレッドセーフではないため、共有せずスレッドごとに1つ構築して使い回す。
_thread_local = threading.local()


def _get_credentials():
    global _credentials
    if _credentials is None:
        with _credentials_lock:
            if _credentials is None:
                _credentials, _ = google.auth.default(scopes=SCOPES)
    return _credentials


def _get_service():
    service = getattr(_thread_local, "service", None)
    if service is None:
        service = build("sheets", "v4", credentials=_get_credentials(), cache_discovery=False)
        _thread_local.service = service
    return service


@dataclass(frozen=True)
class SheetTable:
    headers: list[str]
    rows: list[dict[str, Any]]


def a1_quote(sheet_name: str) -> str:
    return "'" + sheet_name.replace("'", "''") + "'"


class SheetsClient:
    def __init__(self, spreadsheet_id: str):
        self.spreadsheet_id = spreadsheet_id
        self.service = _get_service()

    def get_values(self, sheet_name: str, range_a1: str = "A:ZZ") -> list[list[Any]]:
        result = (
            self.service.spreadsheets()
            .values()
            .get(spreadsheetId=self.spreadsheet_id, range=f"{a1_quote(sheet_name)}!{range_a1}")
            .execute()
        )
        return result.get("values", [])

    def batch_get(self, ranges: Iterable[str]) -> dict[str, list[list[Any]]]:
        result = (
            self.service.spreadsheets()
            .values()
            .batchGet(spreadsheetId=self.spreadsheet_id, ranges=list(ranges))
            .execute()
        )
        return {
            value_range.get("range", ""): value_range.get("values", [])
            for value_range in result.get("valueRanges", [])
        }

    def batch_get_ordered(self, ranges: Iterable[str]) -> list[list[list[Any]]]:
        # valueRanges はリクエストした ranges と同じ順序で返るため、順序で対応づける。
        result = (
            self.service.spreadsheets()
            .values()
            .batchGet(spreadsheetId=self.spreadsheet_id, ranges=list(ranges))
            .execute()
        )
        return [value_range.get("values", []) for value_range in result.get("valueRanges", [])]

    def update_values(
        self,
        sheet_name: str,
        values: list[list[Any]],
        range_a1: str = "A1",
        value_input_option: str = "USER_ENTERED",
    ) -> None:
        (
            self.service.spreadsheets()
            .values()
            .update(
                spreadsheetId=self.spreadsheet_id,
                range=f"{a1_quote(sheet_name)}!{range_a1}",
                valueInputOption=value_input_option,
                body={"values": values},
            )
            .execute()
        )

    def append_values(
        self,
        sheet_name: str,
        values: list[list[Any]],
        value_input_option: str = "USER_ENTERED",
    ) -> None:
        (
            self.service.spreadsheets()
            .values()
            .append(
                spreadsheetId=self.spreadsheet_id,
                range=f"{a1_quote(sheet_name)}!A1",
                valueInputOption=value_input_option,
                insertDataOption="INSERT_ROWS",
                body={"values": values},
            )
            .execute()
        )

    def clear_values(self, sheet_name: str) -> None:
        (
            self.service.spreadsheets()
            .values()
            .clear(
                spreadsheetId=self.spreadsheet_id,
                range=f"{a1_quote(sheet_name)}!A:ZZ",
                body={},
            )
            .execute()
        )


def values_to_table(values: list[list[Any]]) -> SheetTable:
    if not values:
        return SheetTable(headers=[], rows=[])
    headers = [str(value) for value in values[0]]
    rows: list[dict[str, Any]] = []
    for offset, raw_row in enumerate(values[1:], start=2):
        padded = raw_row + [""] * max(0, len(headers) - len(raw_row))
        if not any(value != "" for value in padded):
            continue
        row = {header: padded[index] if index < len(padded) else "" for index, header in enumerate(headers)}
        row["_row_number"] = offset
        rows.append(row)
    return SheetTable(headers=headers, rows=rows)


def table_to_values(headers: list[str], rows: list[dict[str, Any]]) -> list[list[Any]]:
    return [headers] + [[sanitize_sheet_value(row.get(header, "")) for header in headers] for row in rows]


def sanitize_sheet_value(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    if value.startswith(("=", "+", "-", "@", "\t", "\r", "\n")):
        return "'" + value
    return value
