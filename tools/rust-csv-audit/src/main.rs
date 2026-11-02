use std::env;
use std::fs;
use std::process;

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_DATA_ROWS: usize = 100_000;

fn parse_csv(input: &str) -> Result<Vec<Vec<String>>, String> {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut chars = input.chars().peekable();
    let mut quoted = false;
    let mut after_quote = false;

    fn finish_cell(row: &mut Vec<String>, cell: &mut String, after_quote: &mut bool) {
        row.push(std::mem::take(cell).trim().to_owned());
        *after_quote = false;
    }

    fn finish_row(
        rows: &mut Vec<Vec<String>>,
        row: &mut Vec<String>,
        cell: &mut String,
        after_quote: &mut bool,
    ) {
        finish_cell(row, cell, after_quote);
        if row.iter().any(|value| !value.is_empty()) {
            rows.push(std::mem::take(row));
        } else {
            row.clear();
        }
    }

    while let Some(character) = chars.next() {
        if quoted {
            if character == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cell.push('"');
                } else {
                    quoted = false;
                    after_quote = true;
                }
            } else {
                cell.push(character);
            }
        } else if after_quote && character == ',' {
            finish_cell(&mut row, &mut cell, &mut after_quote);
        } else if after_quote && matches!(character, '\r' | '\n') {
            if character == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            finish_row(&mut rows, &mut row, &mut cell, &mut after_quote);
        } else if after_quote && character.is_whitespace() {
            continue;
        } else if after_quote {
            return Err("unexpected text after a quoted CSV field".to_owned());
        } else if character == '"' && cell.trim().is_empty() {
            cell.clear();
            quoted = true;
        } else if character == ',' {
            finish_cell(&mut row, &mut cell, &mut after_quote);
        } else if matches!(character, '\r' | '\n') {
            if character == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            finish_row(&mut rows, &mut row, &mut cell, &mut after_quote);
        } else if character == '"' {
            return Err("quote found inside an unquoted CSV field".to_owned());
        } else {
            cell.push(character);
        }

        if rows.len() > MAX_DATA_ROWS + 1 {
            return Err(format!("CSV exceeds the {MAX_DATA_ROWS} data-row limit"));
        }
    }

    if quoted {
        return Err("unclosed quoted CSV field".to_owned());
    }
    if !cell.is_empty() || !row.is_empty() || after_quote {
        finish_row(&mut rows, &mut row, &mut cell, &mut after_quote);
    }
    if rows.len() > MAX_DATA_ROWS + 1 {
        return Err(format!("CSV exceeds the {MAX_DATA_ROWS} data-row limit"));
    }
    Ok(rows)
}

fn starts_with_formula(value: &str) -> bool {
    let first = value
        .chars()
        .find(|character| !character.is_whitespace() && !character.is_control());
    matches!(first, Some('=' | '+' | '-' | '@'))
}

fn audit(input: &str) -> Result<(usize, usize, usize), String> {
    let rows = parse_csv(input)?;
    let headers = rows
        .first()
        .ok_or_else(|| "CSV contains no rows".to_owned())?;
    let data_rows = rows.len().saturating_sub(1);
    let inconsistent_rows = rows
        .iter()
        .skip(1)
        .filter(|row| row.len() != headers.len())
        .count();
    let formula_cells = rows
        .iter()
        .skip(1)
        .flat_map(|row| row.iter())
        .filter(|cell| starts_with_formula(cell))
        .count();
    Ok((data_rows, inconsistent_rows, formula_cells))
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let file_name = args
        .next()
        .ok_or_else(|| "usage: sentinel-csv-audit <file.csv>".to_owned())?;
    if args.next().is_some() {
        return Err("provide exactly one CSV file path".to_owned());
    }

    let metadata =
        fs::metadata(&file_name).map_err(|error| format!("cannot read file: {error}"))?;
    if metadata.len() > MAX_FILE_BYTES {
        return Err("CSV exceeds the 5 MiB file-size limit".to_owned());
    }
    let content = fs::read_to_string(&file_name)
        .map_err(|error| format!("CSV must be readable UTF-8 text: {error}"))?;
    let (data_rows, inconsistent_rows, formula_cells) = audit(&content)?;
    println!("CSV structure: valid");
    println!("Data rows: {data_rows}");
    println!(
        "Columns: {}",
        parse_csv(&content)?.first().map_or(0, Vec::len)
    );
    println!("Rows with a different column count: {inconsistent_rows}");
    println!("Formula-like cells to review: {formula_cells}");
    Ok(())
}

fn main() {
    if let Err(message) = run() {
        eprintln!("CSV audit failed: {message}");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{audit, parse_csv};

    #[test]
    fn parses_quoted_commas_newlines_and_escaped_quotes() {
        assert_eq!(
            parse_csv("name,note\r\n\"Ada, Inc.\",\"line one\r\nline two\"\r\n\"A\",\"She said \"\"hello\"\"\"")
                .unwrap(),
            vec![
                vec!["name", "note"],
                vec!["Ada, Inc.", "line one\r\nline two"],
                vec!["A", "She said \"hello\""]
            ]
        );
    }

    #[test]
    fn rejects_malformed_quoted_fields() {
        assert!(parse_csv("name\n\"unfinished").is_err());
        assert!(parse_csv("name\nun\"escaped").is_err());
        assert!(parse_csv("name\n\"closed\" trailing").is_err());
    }

    #[test]
    fn reports_row_width_and_formula_review_counts() {
        assert_eq!(
            audit("name,note\nAda,ok\n\"=SUM(1,2)\",review\nshort").unwrap(),
            (3, 1, 1)
        );
        assert_eq!(
            audit("name\n\t@HYPERLINK(https://example.test)").unwrap(),
            (1, 0, 1)
        );
    }
}
