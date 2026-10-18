"""Write results to one Excel workbook with a sheet per table."""
import pandas as pd


def write_workbook(path, sheets):
    with pd.ExcelWriter(path, engine="openpyxl") as xw:
        for name, df in sheets.items():
            out = df.copy()
            for c in out.columns:
                if str(out[c].dtype).startswith("datetime"):
                    out[c] = out[c].dt.date
            out.to_excel(xw, sheet_name=name[:31], index=out.index.name is not None or name == "Aging summary")
            ws = xw.sheets[name[:31]]
            for col in ws.columns:
                width = max(len(str(c.value)) if c.value is not None else 0 for c in col)
                ws.column_dimensions[col[0].column_letter].width = min(max(width + 2, 10), 48)
            ws.freeze_panes = "A2"
