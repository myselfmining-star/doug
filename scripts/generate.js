const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const puppeteer = require('puppeteer');
const os = require('os');
const { processReportData } = require('./extract_data');

async function generatePDF() {
    console.log('🚀 Starting Corrosion Survey Report PDF Generation...');
    
    // Accept dynamic paths from command line args (for Python/PyInstaller integration)
    const dataDir = process.argv[2] || __dirname;
    const jsonFileName = process.argv[3]; // Can be undefined
    const outputPdfPath = process.argv[4] || path.join(__dirname, 'Corrosion_Survey_Report.pdf');

    // 1. Process structured JSON data and Excel mappings
    const reportData = processReportData(dataDir, jsonFileName);
    console.log(`✅ Extracted data: ${reportData.processedCMLs.length} CMLs found.`);

    // 2. Read CSS and Chart.js bundle
    const cssContent = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf-8');
    let chartJsPath = path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
    if (!fs.existsSync(chartJsPath)) {
        chartJsPath = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
    }
    const chartJsContent = fs.readFileSync(chartJsPath, 'utf-8');

    // 3. Render HTML with EJS
    let templateName = 'report_template.ejs';
    if (reportData.formVersion <= 49) {
        templateName = 'report_template_v49.ejs';
        console.log(`📌 Using frozen layout for formVersion <= 49 (${reportData.formVersion})`);
    } else {
        console.log(`📌 Using latest layout for formVersion >= 50 (${reportData.formVersion})`);
    }
    const templatePath = path.join(__dirname, templateName);
    const templateStr = fs.readFileSync(templatePath, 'utf-8');
    
    const htmlContent = ejs.render(templateStr, {
        ...reportData,
        cssContent,
        chartJsContent
    }, { filename: templatePath });

    // Save temporary rendered HTML file for debugging / verification if needed
    const htmlDebugPath = path.join(__dirname, 'rendered_report.html');
    fs.writeFileSync(htmlDebugPath, htmlContent);
    console.log(`📄 Saved HTML preview to ${htmlDebugPath}`);

    // 4. Launch Puppeteer to generate PDF
    console.log('🌐 Launching Puppeteer browser...');
    let launchOptions = {
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files']
    };
    
    // Bulletproof Chrome resolution
    const systemChromium = '/usr/bin/chromium';
    const systemChrome = '/usr/bin/google-chrome';
    
    if (fs.existsSync(systemChromium)) {
        launchOptions.executablePath = systemChromium;
        console.log("🔎 Using system Chromium at /usr/bin/chromium");
    } else if (fs.existsSync(systemChrome)) {
        launchOptions.executablePath = systemChrome;
        console.log("🔎 Using system Chrome at /usr/bin/google-chrome");
    } else {
        const cacheDir = path.join(__dirname, '..', '.puppeteer_cache');
        if (fs.existsSync(cacheDir)) {
            function findChrome(dir) {
                let results = [];
                const list = fs.readdirSync(dir);
                for (let file of list) {
                    const fullPath = path.join(dir, file);
                    const stat = fs.statSync(fullPath);
                    if (stat && stat.isDirectory()) { 
                        results = results.concat(findChrome(fullPath));
                    } else if (file === 'chrome' || file === 'chrome.exe' || file === 'chromium') { 
                        results.push(fullPath);
                    }
                }
                return results;
            }
            const chromePaths = findChrome(cacheDir);
            if (chromePaths.length > 0) {
                // Just take the first valid chrome binary we found (ignoring my previous overly strict chrome-linux64 filter)
                launchOptions.executablePath = chromePaths[0];
                console.log(`🔎 Found local Chrome at: ${chromePaths[0]}`);
            }
        }
    }

    const browser = await puppeteer.launch(launchOptions);

    async function createPdfFile(cmlSubset, suffix) {
        if (!cmlSubset || cmlSubset.length === 0) return;
        
        console.log(`\n📄 Generating ${suffix} Report with ${cmlSubset.length} CMLs...`);
        let reportSubtitle = 'PRESSURE EQUIPMENT / PRESSURE PIPING';
        if (suffix === 'Vessel') reportSubtitle = 'PRESSURE VESSEL';
        if (suffix === 'Piping') reportSubtitle = 'PRESSURE PIPING';

        const subsetData = {
            ...reportData,
            processedCMLs: cmlSubset,
            cssContent,
            chartJsContent,
            reportSubtitle
        };
        
        const htmlContent = ejs.render(templateStr, subsetData, { filename: templatePath });
        const htmlDebugPath = path.join(__dirname, `rendered_report_${suffix.toLowerCase()}.html`);
        fs.writeFileSync(htmlDebugPath, htmlContent);

        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 2 });
        
        // RESTORED PATCH: Load rendered HTML content from the saved file to avoid CDP string payload limits and timeouts
        const fileUrl = 'file:///' + htmlDebugPath.replace(/\\/g, '/');
        await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 60000 });
        
        await page.evaluate(() => {
            document.querySelectorAll('canvas').forEach(canvas => {
                canvas.style.fontFamily = 'Inter';
            });
        });
        
        // Give Chart.js animations/rendering 1.5 seconds to settle
        await new Promise(resolve => setTimeout(resolve, 1500));

        let finalOutputPath = outputPdfPath;
        if (outputPdfPath.toLowerCase().endsWith('.pdf')) {
            finalOutputPath = outputPdfPath.slice(0, -4) + `_${suffix}.pdf`;
        } else {
            finalOutputPath = outputPdfPath + `_${suffix}.pdf`;
        }

        await page.pdf({
            path: finalOutputPath,
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: false,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            preferCSSPageSize: true
        });
        console.log(`✅ Saved ${suffix} PDF to ${finalOutputPath}`);
        await page.close();
        
        // Clean up temporary HTML file
        if (fs.existsSync(htmlDebugPath)) {
            fs.unlinkSync(htmlDebugPath);
        }
    }

    const pipingCMLs = reportData.processedCMLs.filter(cml => cml.componentName === 'Piping');
    const vesselCMLs = reportData.processedCMLs.filter(cml => cml.componentName !== 'Piping');

    if (pipingCMLs.length > 0) {
        await createPdfFile(pipingCMLs, 'Piping');
    }
    
    if (vesselCMLs.length > 0) {
        await createPdfFile(vesselCMLs, 'Vessel');
    }

    if (pipingCMLs.length === 0 && vesselCMLs.length === 0) {
        // Fallback for an empty report
        await createPdfFile([], 'Empty');
    }

    await browser.close();
    console.log('\n🎉 All PDF splits generated successfully!');
}

generatePDF().catch(err => {
    console.error('❌ Error generating PDF:', err);
    process.exit(1);
});
