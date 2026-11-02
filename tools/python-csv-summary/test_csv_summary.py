import csv
import tempfile
import unittest
from pathlib import Path

from csv_summary import MAX_DATA_ROWS, analyze_csv


class CsvSummaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.csv_path = Path(self.temp_dir.name) / "clients.csv"

    def test_summarizes_quoted_values_and_deduplicates_contacts(self) -> None:
        self.csv_path.write_text(
            'Company,Email,Notes\r\n'
            '"Ada, Inc.",Ada@example.test,"Line one\r\nline two"\r\n'
            'Beta,beta@example.test,ok\r\n'
            '"ADA, INC.",ada@example.test,duplicate contact\r\n',
            encoding="utf-8",
        )
        self.assertEqual(
            analyze_csv(self.csv_path),
            {
                "file": "clients.csv",
                "data_rows": 3,
                "columns": 3,
                "unique_email_contacts": 2,
                "unique_company_names": 2,
                "complete_rows_percent": 100,
            },
        )

    def test_reports_incomplete_rows_and_rejects_malformed_csv(self) -> None:
        self.csv_path.write_text("Company,Email\nAcme,\n", encoding="utf-8")
        self.assertEqual(analyze_csv(self.csv_path)["complete_rows_percent"], 0)
        self.csv_path.write_text('Company,Email\n"Unclosed,email@example.test\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "malformed quoted"):
            analyze_csv(self.csv_path)

    def test_enforces_file_size_and_record_limits(self) -> None:
        self.csv_path.write_bytes(b"x" * (5 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "file-size limit"):
            analyze_csv(self.csv_path)

        with self.csv_path.open("w", encoding="utf-8", newline="") as output:
            writer = csv.writer(output)
            writer.writerow(["company"])
            writer.writerows([["Acme"]] * (MAX_DATA_ROWS + 1))
        with self.assertRaisesRegex(ValueError, "data-row limit"):
            analyze_csv(self.csv_path)

    def test_accepts_large_field_within_file_limit(self) -> None:
        self.csv_path.write_text(f"Notes\n{'x' * 200_000}\n", encoding="utf-8")
        self.assertEqual(analyze_csv(self.csv_path)["data_rows"], 1)


if __name__ == "__main__":
    unittest.main()
