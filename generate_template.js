const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const sampleRows = [
  {
    "First Name": "Hanavi",
    "Last Name": "keshav",
    "Designation": "Engineer",
    "Email Address": "hanavi@gmail.com",
    "Organization Type": "Private Org",
    "City": "Bangalore",
    "Phone Number": "7656786567",
    "Category / ID": "13",
    "Terms Acceptance": "I accept the terms & conditions",
    "Nominee / Project / Scheme": "Bharatha Rathna Dr. B.R. Ambedkar Karmika Seva Kendra (KSK) - Karnataka Building & Other Construction Workers Welfare board, Labour Department.",
    "State": "Karnataka"
  },
  {
    "First Name": "Rahul",
    "Last Name": "Sharma",
    "Designation": "Software Developer",
    "Email Address": "rahul.sharma@example.com",
    "Organization Type": "Private Org",
    "City": "Bangalore",
    "Phone Number": "9876543210",
    "Category / ID": "13",
    "Terms Acceptance": "I accept the terms & conditions",
    "Nominee / Project / Scheme": "Bharatha Rathna Dr. B.R. Ambedkar Karmika Seva Kendra (KSK) - Karnataka Building & Other Construction Workers Welfare board, Labour Department.",
    "State": "Karnataka"
  },
  {
    "First Name": "Priya",
    "Last Name": "Nair",
    "Designation": "Senior Architect",
    "Email Address": "priya.nair@example.com",
    "Organization Type": "Public Sector",
    "City": "Mysore",
    "Phone Number": "9123456780",
    "Category / ID": "13",
    "Terms Acceptance": "I accept the terms & conditions",
    "Nominee / Project / Scheme": "Bharatha Rathna Dr. B.R. Ambedkar Karmika Seva Kendra (KSK) - Karnataka Building & Other Construction Workers Welfare board, Labour Department.",
    "State": "Karnataka"
  },
  {
    "First Name": "Ananya",
    "Last Name": "Rao",
    "Designation": "Project Lead",
    "Email Address": "ananya.rao@example.com",
    "Organization Type": "Private Org",
    "City": "Mangalore",
    "Phone Number": "9845012345",
    "Category / ID": "13",
    "Terms Acceptance": "I accept the terms & conditions",
    "Nominee / Project / Scheme": "Bharatha Rathna Dr. B.R. Ambedkar Karmika Seva Kendra (KSK) - Karnataka Building & Other Construction Workers Welfare board, Labour Department.",
    "State": "Karnataka"
  },
  {
    "First Name": "Vikram",
    "Last Name": "Patel",
    "Designation": "Civil Engineer",
    "Email Address": "vikram.patel@example.com",
    "Organization Type": "Government Contractor",
    "City": "Hubli",
    "Phone Number": "9988776655",
    "Category / ID": "13",
    "Terms Acceptance": "I accept the terms & conditions",
    "Nominee / Project / Scheme": "Bharatha Rathna Dr. B.R. Ambedkar Karmika Seva Kendra (KSK) - Karnataka Building & Other Construction Workers Welfare board, Labour Department.",
    "State": "Karnataka"
  }
];

function generateTemplates() {
  const ws = XLSX.utils.json_to_sheet(sampleRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Form_Responses");

  // Write Excel file
  const excelPath = path.join(__dirname, 'template_form_data.xlsx');
  XLSX.writeFile(wb, excelPath);
  console.log(`Created Excel template at: ${excelPath}`);

  // Write CSV file
  const csvPath = path.join(__dirname, 'template_form_data.csv');
  const csvContent = XLSX.utils.sheet_to_csv(ws);
  fs.writeFileSync(csvPath, csvContent, 'utf-8');
  console.log(`Created CSV template at: ${csvPath}`);
}

generateTemplates();
