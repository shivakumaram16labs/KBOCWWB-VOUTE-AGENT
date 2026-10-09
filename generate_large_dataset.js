const fs = require('fs');
const path = require('path');

const firstNames = ["Rahul", "Priya", "Vikram", "Ananya", "Amit", "Sneha", "Rohan", "Kavya", "Suresh", "Pooja", "Arjun", "Meera", "Kiran", "Divya", "Siddharth"];
const lastNames = ["Sharma", "Nair", "Patel", "Rao", "Verma", "Kumar", "Iyer", "Gowda", "Deshmukh", "Reddy", "Menon", "Joshi", "Gupta", "Bhat"];
const designations = ["Software Engineer", "Civil Engineer", "Project Manager", "Architect", "Consultant", "Director", "Officer", "Supervisor", "Lead Engineer"];
const cities = ["Bangalore", "Mysore", "Hubli", "Mangalore", "Belgaum", "Gulbarga", "Davanagere", "Bellary", "Shimoga", "Tumkur"];

function generateLargeCsv(filePath, totalRows = 1000000) {
  console.log(`Generating ${totalRows.toLocaleString()} rows to ${filePath}...`);
  const writeStream = fs.createWriteStream(filePath, { flags: 'w' });

  // Header
  writeStream.write(`First Name,Last Name,Designation,Email Address,Organization Type,City,Phone Number,Category / ID,Terms Acceptance,Nominee / Project / Scheme,State\n`);

  for (let i = 1; i <= totalRows; i++) {
    const fn = firstNames[i % firstNames.length];
    const ln = lastNames[i % lastNames.length];
    const des = designations[i % designations.length];
    const city = cities[i % cities.length];
    const phone = `9${Math.floor(100000000 + Math.random() * 900000000)}`;
    const email = `${fn.toLowerCase()}.${ln.toLowerCase()}${i}@example.com`;
    const scheme = "Bharatha Rathna Dr. B.R. Ambedkar Karmika Seva Kendra (KSK) - Karnataka Building & Other Construction Workers Welfare board, Labour Department.";

    writeStream.write(`"${fn}","${ln}","${des}","${email}","Private Org","${city}","${phone}","13","I accept the terms & conditions","${scheme}","Karnataka"\n`);

    if (i % 100000 === 0) {
      console.log(`  -> Written ${i.toLocaleString()} / ${totalRows.toLocaleString()} rows...`);
    }
  }

  writeStream.end(() => {
    console.log(`✅ 10 Lakhs (1,000,000) dataset generated successfully at: ${filePath}`);
  });
}

// Generate 10k by default if called standalone (or 10L when passed argument)
const count = parseInt(process.argv[2]) || 10000;
const targetPath = path.join(__dirname, `test_dataset_${count}.csv`);
generateLargeCsv(targetPath, count);
