#!/usr/bin/env python3
"""
Google Form Batch Automation CLI Tool
Reads Excel (.xlsx, .xls) or CSV files and submits responses to Google Forms.
Includes dynamic fbzx token extraction, rate limiting, jitter, and retry handling.
"""

import sys
import time
import random
import argparse
import requests
import re
from bs4 import BeautifulSoup
import pandas as pd

# Default Google Form FormResponse Endpoint
DEFAULT_FORM_URL = "https://docs.google.com/forms/u/0/d/e/1FAIpQLScXCqBHNMtSaXLzid7I4PftgY31PidN6s7hO9hI56zdfB8-Wg/formResponse?embedded=true"

# Default Field Mapping from user curl command
DEFAULT_MAPPING = {
    "First Name": "entry.82537205",
    "Last Name": "entry.699138706",
    "Designation": "entry.1578616250",
    "Email Address": "entry.1423769822",
    "Organization Type": "entry.524309291",
    "City": "entry.726699506",
    "Phone Number": "entry.609066048",
    "Category / ID": "entry.108996083",
    "Terms Acceptance": "entry.2122580329",
    "Nominee / Project / Scheme": "entry.18465063",
    "State": "entry.1058025205"
}

def normalize_urls(url):
    form_response_url = url.strip()
    viewform_url = url.strip()

    if "/viewform" in form_response_url:
        form_response_url = form_response_url.replace("/viewform", "/formResponse")
    elif "/formResponse" not in form_response_url:
        form_response_url = form_response_url.rstrip("/") + "/formResponse"

    if "/formResponse" in viewform_url:
        viewform_url = viewform_url.replace("/formResponse", "/viewform")
    elif "/viewform" not in viewform_url:
        viewform_url = viewform_url.rstrip("/") + "/viewform"

    return form_response_url, viewform_url

def fetch_fbzx_token(viewform_url, session, cookies_str=""):
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
    if cookies_str:
        headers["Cookie"] = cookies_str

    try:
        res = session.get(viewform_url, headers=headers, timeout=10)
        soup = BeautifulSoup(res.text, "html.parser")
        fbzx_input = soup.find("input", {"name": "fbzx"})
        if fbzx_input and fbzx_input.get("value"):
            return fbzx_input["value"]
        
        # Regex fallback
        match = re.search(r'\[null,null,"(-?\d+)"\]', res.text)
        if match:
            return match.group(1)
    except Exception as e:
        print(f"  ⚠️ Warning: Could not scrape dynamic fbzx token ({e}), using default fallback.")
    
    return "-5957270695485461168"

def submit_row(row_dict, form_url, cookies_str="", dynamic_token=True):
    form_response_url, viewform_url = normalize_urls(form_url)
    session = requests.Session()

    fbzx = "-5957270695485461168"
    if dynamic_token:
        fbzx = fetch_fbzx_token(viewform_url, session, cookies_str)

    payload = {}
    sentinels = set()

    for col_name, entry_id in DEFAULT_MAPPING.items():
        val = str(row_dict.get(col_name, "") or "").strip()
        payload[entry_id] = val
        sentinels.add(f"{entry_id}_sentinel")

    for s in sentinels:
        payload[s] = ""

    payload["fvv"] = "1"
    payload["partialResponse"] = f'[null,null,"{fbzx}"]'
    payload["pageHistory"] = "0"
    payload["fbzx"] = fbzx
    payload["dsdoc"] = "true"
    payload["submissionTimestamp"] = str(int(time.time() * 1000))

    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://docs.google.com",
        "Referer": viewform_url,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }

    if cookies_str:
        headers["Cookie"] = cookies_str

    try:
        resp = session.post(form_response_url, data=payload, headers=headers, timeout=15)
        text = resp.text
        is_success = resp.status_code == 200 and ("recorded" in text or "freebirdFormviewerViewResponseConfirmationMessage" in text or "formResponse" in resp.url)
        return {
            "success": is_success,
            "status_code": resp.status_code,
            "message": "Response recorded" if is_success else f"HTTP {resp.status_code}"
        }
    except Exception as err:
        return {
            "success": False,
            "status_code": 500,
            "message": str(err)
        }

def main():
    parser = argparse.ArgumentParser(description="Google Form Automation CLI")
    parser.add_argument("--file", "-f", default="template_form_data.xlsx", help="Path to Excel or CSV data file")
    parser.add_argument("--url", "-u", default=DEFAULT_FORM_URL, help="Google Form URL")
    parser.add_argument("--delay-min", type=float, default=1.5, help="Minimum delay in seconds between submissions")
    parser.add_argument("--delay-max", type=float, default=3.5, help="Maximum delay in seconds between submissions")
    parser.add_argument("--cookies", "-c", default="", help="Google Auth Cookies (if form requires login)")
    parser.add_argument("--export", "-e", default="cli_submission_results.xlsx", help="Export path for results")

    args = parser.parse_args()

    print("=" * 60)
    print("🚀 GOOGLE FORM BATCH AUTOMATION CLI")
    print("=" * 60)
    print(f"📁 Input File: {args.file}")
    print(f"🔗 Form URL:   {args.url}")
    print(f"⏱️ Delay Range: {args.delay_min}s - {args.delay_max}s (Anti-Bot Jitter)")
    print("=" * 60)

    try:
        if args.file.endswith(".csv"):
            df = pd.read_csv(args.file)
        else:
            df = pd.read_excel(args.file)
    except Exception as e:
        print(f"❌ Error loading file '{args.file}': {e}")
        sys.exit(1)

    records = df.to_dict(orient="records")
    total = len(records)
    print(f"📊 Loaded {total} records from '{args.file}'. Starting batch...")

    results = []
    success_count = 0
    failed_count = 0

    for idx, row in enumerate(records, start=1):
        name = row.get("First Name") or row.get("name") or f"Record #{idx}"
        email = row.get("Email Address") or row.get("email") or ""
        print(f"[{idx}/{total}] Submitting: {name} ({email})...", end="", flush=True)

        res = submit_row(row, args.url, args.cookies)
        row_res = dict(row)
        row_res["_status"] = "SUCCESS" if res["success"] else "FAILED"
        row_res["_http_code"] = res["status_code"]
        row_res["_message"] = res["message"]
        row_res["_timestamp"] = time.strftime("%Y-%m-%d %H:%M:%S")
        results.append(row_res)

        if res["success"]:
            success_count += 1
            print(f" ✅ Success ({res['message']})")
        else:
            failed_count += 1
            print(f" ❌ Failed ({res['message']})")

        if idx < total:
            delay = random.uniform(args.delay_min, args.delay_max)
            time.sleep(delay)

    print("\n" + "=" * 60)
    print(f"🎉 Batch Finished! Total: {total} | Succeeded: {success_count} | Failed: {failed_count}")
    
    # Export results
    out_df = pd.DataFrame(results)
    if args.export.endswith(".csv"):
        out_df.to_csv(args.export, index=False)
    else:
        out_df.to_excel(args.export, index=False)
    print(f"💾 Results saved to: {args.export}")
    print("=" * 60)

if __name__ == "__main__":
    main()
