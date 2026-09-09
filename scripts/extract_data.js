const fs = require('fs');
const path = require('path');

// Helper to recursively find a file
function findFileSync(startPath, filter) {
    if (!fs.existsSync(startPath)) return null;
    const stat = fs.lstatSync(startPath);
    if (!stat.isDirectory()) return null;
    
    const files = fs.readdirSync(startPath);
    for (let i = 0; i < files.length; i++) {
        const filename = path.join(startPath, files[i]);
        const fileStat = fs.lstatSync(filename);
        if (fileStat.isDirectory()) {
            const found = findFileSync(filename, filter);
            if (found) return found;
        } else if (path.basename(filename).toLowerCase() === filter.toLowerCase()) {
            return filename;
        }
    }
    return null;
}

// Helper to convert local image to base64 data URI
function imageToBase64(imgPath, baseDir) {
    if (!imgPath) return null;
    let fullPath = path.isAbsolute(imgPath) ? imgPath : path.join(baseDir, imgPath);
    
    // Prevent cross-contamination: if an examiner's specific ID is missing, DO NOT search the whole directory
    // otherwise it will find another examiner's ID card and use it.
    const isExaminerImage = imgPath.includes('Examiner Info');
    
    if (!fs.existsSync(fullPath)) {
        if (isExaminerImage) {
            return null; // Leave the box empty instead of borrowing someone else's ID
        }
        
        const found = findFileSync(baseDir, path.basename(imgPath));
        if (found) {
            fullPath = found;
        } else {
            return null;
        }
    }
    
    const ext = path.extname(fullPath).toLowerCase();
    let mimeType = 'image/jpeg';
    if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.svg') mimeType = 'image/svg+xml';
    else if (ext === '.gif') mimeType = 'image/gif';
    else if (ext === '.webp') mimeType = 'image/webp';
    
    const data = fs.readFileSync(fullPath);
    return `data:${mimeType};base64,${data.toString('base64')}`;
}

// Load excel mappings from mappings.json
function loadExcelMappings(projectDir) {
    const mappingsJsonPath = path.join(projectDir, 'mappings.json');
    if (fs.existsSync(mappingsJsonPath)) {
        return JSON.parse(fs.readFileSync(mappingsJsonPath, 'utf-8'));
    }

    // Scope Data Group
    const scopeData = [
        { label: 'Corrosion Survey Scope', value: formatVal(rawData.SCOPE) },
        { label: 'Corrosion Survey Method', value: formatVal(rawData.METHOD) },
        { label: 'Corrosion Survey Calibration', value: formatVal(rawData.METHOD_1) },
        { label: 'Corrosion Survey Instrument Settings', value: formatVal(rawData.METHOD_2) },
        { label: 'Corrosion Survey Special Equipment', value: formatVal(rawData.METHOD_3) },
        { label: 'Corrosion Survey Acceptance', value: formatVal(rawData.METHOD_4) }
    ];

    return {};
}

function governing(cml) {
    const component = cml.EV_COMPONENT || (cml.FV_COMPONENT ? (Array.isArray(cml.FV_COMPONENT) ? cml.FV_COMPONENT[0] : cml.FV_COMPONENT) : null) || cml.DB_COMPONENT || 'Shell';
    
    if (component === "Nozzle") {
        return cml.UG_45_TMIN;
    }

    if (component === "Piping") {
        const b313Raw = cml.B313_PIPING_CALCULATION;
        const b313 = parseFloat(b313Raw);
        if (isNaN(b313)) {
            return b313Raw || 'N/A';
        }
        return Math.max(b313, 0.100).toFixed(3);
    }

    const keyMap = {
        "Shell":       "UG_27_SHELL",
        "Boot":        "UG_27_BOOT",
        "Top Head":    "UG_32_TOP",
        "Left Head":   "UG_32_LEFT",
        "Bottom Head": "UG_32_BOTTOM",
        "Right Head":  "UG_32_RIGHT"
    };

    const key = keyMap[component];
    if (key) {
        return cml[key] !== undefined ? cml[key] : 'N/A';
    }
    
    return 'N/A';
}

function processReportData(dataDir, jsonFileName) {
    if (!jsonFileName || jsonFileName === 'undefined') {
        const files = fs.readdirSync(dataDir);
        jsonFileName = files.find(f => f.endsWith('.json')) || 'ece93dc9-a3f7-4bae-ac70-c714b20494ae.json';
    }
    const jsonPath = path.isAbsolute(jsonFileName) ? jsonFileName : path.join(dataDir, jsonFileName);
    const rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    
    // V50 formatting stores repeating elements (Probes, Cal Blocks, etc) in section arrays
    // We flatten them into root keys (using the 'appended' property for unique naming) to match legacy logic
    for (const [key, value] of Object.entries(rawData)) {
        if (key.startsWith('section_') && Array.isArray(value)) {
            value.forEach(item => {
                if (item && item.fields) {
                    const suffix = item.appended || '';
                    for (const [fKey, fVal] of Object.entries(item.fields)) {
                        rawData[`${fKey}${suffix}`] = fVal;
                    }
                }
            });
        }
    }
    const mapping = loadExcelMappings(__dirname);

    // Label lookup helper
    const getLabel = (key) => {
        let label = mapping[key] || key;
        return label.replace(/^EV\s*-\s*/i, '');
    };

    // Helper to format values nicely
    const formatVal = (val) => {
        if (val === null || val === undefined || val === '') return 'N/A';
        if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : 'N/A';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
    };

    // Images Base64 mapping
    const headerLogo = imageToBase64('logo.png', __dirname);
    const headerText = imageToBase64('text.png', __dirname);
    const headerLine = imageToBase64('orange line.png', __dirname);
    const nameImg = imageToBase64(rawData.NAME_IMG, dataDir);
    const overImg = imageToBase64(rawData.OVER_IMG, dataDir);
    
    // ISO Images mapping (up to 5)
    const isoImages = [];
    const isoKeys = ['ISO_IMG', 'ISO_IMG_1', 'ISO_IMG_2', 'ISO_IMG_3', 'ISO_IMG_4'];
    isoKeys.forEach(key => {
        let imgPath = rawData[key];
        
        // Check all entries in section_53 if not found at root
        if (!imgPath && rawData.section_53 && Array.isArray(rawData.section_53)) {
            for (let i = 0; i < rawData.section_53.length; i++) {
                if (rawData.section_53[i] && rawData.section_53[i].fields && rawData.section_53[i].fields[key]) {
                    imgPath = rawData.section_53[i].fields[key];
                    break;
                }
            }
        }
        if (imgPath) {
            const base64 = imageToBase64(imgPath, dataDir);
            if (base64) {
                isoImages.push(base64);
            }
        }
    });

    const leaseImg = imageToBase64(rawData.LEASE_IMG, dataDir);
    const bldImg = imageToBase64(rawData.BLD_IMG, dataDir);
    
    // Certification Images
    const examinerNameForPath = rawData.EXAMINER || rawData.INSP_NAME || '';
    const certAt1 = imageToBase64(`Examiner Info/${examinerNameForPath}/Identity Asset Tracker front.png`, __dirname);
    const certAt2 = imageToBase64(`Examiner Info/${examinerNameForPath}/Identity Asset Tracker back.png`, __dirname);
    const certNrcanFront = imageToBase64(`Examiner Info/${examinerNameForPath}/Identity Front.png`, __dirname);
    const certNrcanBack = imageToBase64(`Examiner Info/${examinerNameForPath}/Identity Back.png`, __dirname);

    let sigImgPath = null;
    let sigChiefImgPath = null;
    let finalReport = {};
    if (rawData.FINAL_REPORT && rawData.FINAL_REPORT.length > 0) {
        finalReport = rawData.FINAL_REPORT[0];
        sigImgPath = finalReport.SIG_FIELD;
        sigChiefImgPath = finalReport.SIG_CHIEF;
    }
    
    // Add reviewerName and fieldSummary fallbacks
    finalReport.reviewerName = finalReport.REV_BY && finalReport.REV_BY.length > 0 
        ? finalReport.REV_BY.join(', ') 
        : 'Pending Review';
        
    finalReport.fieldSummary = finalReport.FIELD_SUMMARY || 'Based on the ultrasonic thickness evaluation and API visual inspection, the asset demonstrates acceptable structural integrity. No immediate critical concerns were identified that would compromise safe operation under current parameters. Routine monitoring should continue per the recommended inspection interval.';
    
    // Attach Examiner Certifications to finalReport so the EJS template can render them dynamically in the signature block
    finalReport.EXAMINER_1 = formatVal(rawData.EXAMINER_1); // CGSB UT Number
    finalReport.EXAMINER_2 = formatVal(rawData.EXAMINER_2); // CGSB UT Level
    finalReport.EXAMINER_3 = formatVal(rawData.EXAMINER_3); // ASNT UT Number
    finalReport.EXAMINER_4 = formatVal(rawData.EXAMINER_4); // ASNT UT Level
    
    const formatDate = (val) => {
        if (!val || val === 'N/A') return 'N/A';
        if (typeof val === 'string' && val.includes('T')) {
            return val.split('T')[0];
        }
        return formatVal(val);
    };

    // Formatting the review date and timestamp properly
    finalReport.formattedRevDate = formatDate(finalReport.REV_DATE);
    finalReport.formattedSigTimestamp = formatDate(finalReport.SIG_TIMESTAMP || finalReport.EQUIP_INSP_DATE);
    
    // Prioritize signature from Examiner Info directory
    let sigImg = imageToBase64(`Examiner Info/${examinerNameForPath}/Signature.png`, __dirname);
    if (!sigImg) {
        sigImg = imageToBase64(sigImgPath, dataDir);
    }
    const sigChiefImg = imageToBase64(sigChiefImgPath, dataDir);

    // Global Header Data
    const headerData = {
        owner: formatVal(rawData.EV_OWNER_1),
        sequence: formatVal(rawData.sequenceNumber),
        date: formatVal(rawData.EV_EVENT_DATE || rawData.EVENT_DATE)
    };

    // Static High-Level Data for Cover Page
    const coverData = {
        clientName: formatVal(rawData.INSP_CO || 'Barrel Oil Corp.'),
        assetClass: formatVal(rawData.EV_MANU_3 || rawData.VESSEL_SELECTOR || rawData.DB_EQUIP_1 || '3-Phase Separator'),
        registry: formatVal(rawData.EV_REG_1 || rawData.EV_REG_2 || 'A0631237'),
        equipId: formatVal(rawData.EV_TAGGING_4 || rawData.EV_TAGGING_1 || 'N/A'),
        serialNumber: formatVal(rawData.EV_MANU_1 || 'N/A'),
        crn: formatVal(rawData.EV_REG_4 || 'V7852.213'),
        tagSerial: formatVal((rawData.EV_TAGGING_1 || 'V-101') + ' / ' + (rawData.EV_REG_2 || '251687')),
        location: formatVal(rawData.EV_LOCATION_1 || rawData.EV_LOCATION_2 || rawData.DB_LOCATION_1 || 'Central Alberta'),
        inServiceYear: formatVal(rawData.EV_BLD_YEAR || rawData.SUB_BUILD_YEAR || '2013'),
        redBoxText: [
            formatVal(rawData.EV_OWNER_1 || 'BARREL OIL CORP.'),
            'FACILITY: ' + formatVal(rawData.EV_LOCATION_1 || 'CENTRAL ALBERTA'),
            'LSD: ' + formatVal(rawData.EV_UWID_1 || '10-26-034-21W4M'),
            'SURFACE 52.0124 N, -112.5412 W',
            'FLAMMABLE GAS - CATEGORY 3',
            'EMERGENCY CALL: 1-800-555-0199'
        ]
    };

        const ndtTableData = [
        { equipment: 'Ultrasonic Thickness Gauge', makeModel: 'Olympus 38DL Plus', serialNumber: 'UT-38DL-8592', size: '-', calDate: '2026-04-12', calDue: '2027-04-12' }
    ];

    // Calibration Blocks (up to 3)
    const calKeys = [
        { type: 'CAL_BLOCK_TYPE', mat: 'CAL_BLOCK_MATERIAL', ser: 'CAL_BLOCK_SERIAL' },
        { type: 'CAL_BLOCK_TYPE_1', mat: 'CAL_BLOCK_MATERIAL_1', ser: 'CAL_BLOCK_SERIAL_1' },
        { type: 'CAL_BLOCK_TYPE_2', mat: 'CAL_BLOCK_MATERIAL_2', ser: 'CAL_BLOCK_SERIAL_2' }
    ];
    let calFound = false;
    calKeys.forEach((keys, idx) => {
        if (rawData[keys.type] || rawData[keys.mat] || rawData[keys.ser]) {
            calFound = true;
            
            const bType = formatVal(rawData[keys.type]);
            const bMat = formatVal(rawData[keys.mat]);
            let makeModel = [bType, bMat].filter(x => x !== 'N/A' && x !== '-').join(' ');
            if (!makeModel) makeModel = '-';

            let eqName = 'Calibration Block';
            if (idx === 1) eqName = 'Calibration Block_1';
            if (idx === 2) eqName = 'Calibration Block_2';
            
            ndtTableData.push({
                equipment: eqName,
                makeModel: makeModel,
                serialNumber: formatVal(rawData[keys.ser]) !== 'N/A' ? formatVal(rawData[keys.ser]) : '-',
                size: '-',
                calDate: '-',
                calDue: '-'
            });
        }
    });
    // Fallback if none exist to preserve original visual layout
    if (!calFound) {
        ndtTableData.push({ equipment: 'Calibration Block', makeModel: '-', serialNumber: '-', size: '-', calDate: '-', calDue: '-' });
    }

    // Probes (up to 2)
    const probeKeys = [
        { manu: 'PROBE_MANU', model: 'PROBE_MODEL', ser: 'PROBE_SERIAL', size: 'PROBE_SIZE' },
        { manu: 'PROBE_MANU_1', model: 'PROBE_MODEL_1', ser: 'PROBE_SERIAL_1', size: 'PROBE_SIZE_1' }
    ];
    let probeFound = false;
    probeKeys.forEach((keys, idx) => {
        if (rawData[keys.manu] || rawData[keys.model] || rawData[keys.ser] || rawData[keys.size]) {
            probeFound = true;
            const manu = formatVal(rawData[keys.manu]);
            const model = formatVal(rawData[keys.model]);
            let makeModel = [manu, model].filter(x => x !== 'N/A' && x !== '-').join(' ');
            if (!makeModel) makeModel = '-';
            
            ndtTableData.push({
                equipment: idx === 0 ? 'Probe' : 'Probe 2',
                makeModel: makeModel,
                serialNumber: formatVal(rawData[keys.ser]) !== 'N/A' ? formatVal(rawData[keys.ser]) : '-',
                size: formatVal(rawData[keys.size]) !== 'N/A' ? formatVal(rawData[keys.size]) : '-',
                calDate: '-',
                calDue: '-'
            });
        }
    });
    // Fallback if none exist to preserve original visual layout
    if (!probeFound) {
        ndtTableData.push({ equipment: 'Probe', makeModel: '-', serialNumber: '-', size: '-', calDate: '-', calDue: '-' });
    }

    if (rawData.CABLE_MANU || rawData.CABLE_TYPE || rawData.CABLE_LENGTH) {
        const cMake = formatVal(rawData.CABLE_MANU);
        const cType = formatVal(rawData.CABLE_TYPE);
        let makeModel = [cMake, cType].filter(x => x !== 'N/A' && x !== '-').join(' ');
        if (!makeModel) makeModel = '-';
        let sizeVal = formatVal(rawData.CABLE_LENGTH);
        if (sizeVal === 'N/A') sizeVal = '-';
        
        ndtTableData.push({
            equipment: 'Cable',
            makeModel: makeModel,
            serialNumber: '-',
            size: sizeVal,
            calDate: '-',
            calDue: '-'
        });
    }

    if (rawData.CABLE_MANU_1 || rawData.CABLE_TYPE_1 || rawData.CABLE_LENGTH_1) {
        const cMake = formatVal(rawData.CABLE_MANU_1);
        const cType = formatVal(rawData.CABLE_TYPE_1);
        let makeModel = [cMake, cType].filter(x => x !== 'N/A' && x !== '-').join(' ');
        if (!makeModel) makeModel = '-';
        let sizeVal = formatVal(rawData.CABLE_LENGTH_1);
        if (sizeVal === 'N/A') sizeVal = '-';

        ndtTableData.push({
            equipment: 'Cable 2',
            makeModel: makeModel,
            serialNumber: '-',
            size: sizeVal,
            calDate: '-',
            calDue: '-'
        });
    }

    // Dashboard Scorecard metrics
    let cmlList = rawData.CML_SUB || [];
    if (!Array.isArray(cmlList)) cmlList = [cmlList];
    let cautionsCount = 0;
    let criticalsCount = 0;

    const processedCMLs = cmlList.map((cml, idx) => {
        // CML photo mapping
        let photoPath = null;
        if (cml.CML_IMG && Array.isArray(cml.CML_IMG) && cml.CML_IMG.length > 0) {
            photoPath = cml.CML_IMG[0].photo;
        } else {
            for (let k in cml) {
                if (k.startsWith('EV') && k.endsWith('IMG') && cml[k]) {
                    photoPath = cml[k];
                    break;
                }
            }
        }
        const cmlPhoto = imageToBase64(photoPath, dataDir);

        let componentName = cml.EV_COMPONENT || (cml.FV_COMPONENT ? (Array.isArray(cml.FV_COMPONENT) ? cml.FV_COMPONENT[0] : cml.FV_COMPONENT) : null) || cml.DB_COMPONENT;
        if (!componentName) componentName = 'Shell';
        componentName = formatVal(componentName);

        let tMinRawOld = null;
        if (componentName === 'Piping') tMinRawOld = cml.B313_PIPING_CALCULATION;
        else if (componentName === 'Shell') tMinRawOld = cml.UG_27_SHELL;
        else if (componentName === 'Nozzle') tMinRawOld = cml.UG_27_NOZZLE;
        else if (componentName === 'Top Head') tMinRawOld = cml.UG_32_TOP;
        else if (componentName === 'Bottom Head') tMinRawOld = cml.UG_32_BOTTOM;

        const tMin = (tMinRawOld && tMinRawOld !== 'N/A') ? parseFloat(tMinRawOld) : null;
        const tMinRaw = governing(cml);
        const nomThk = parseFloat(cml.EV_NOM_THK || cml.FV_NOM_THK || 0.094) || 0.094;

        const hasBase = cml.MIN_BASE && cml.MIN_BASE !== 'N/A';
        const hasPrev = cml.MIN_PREVIOUS && cml.MIN_PREVIOUS !== 'N/A';
        const hasIntermediate = cml.MIN_INTERMEDIATE && cml.MIN_INTERMEDIATE !== 'N/A';
        const hasCurrent = cml.MIN_CURRENT && cml.MIN_CURRENT !== 'N/A';

        const installThk = hasBase ? parseFloat(cml.MIN_BASE) : null;
        const prevThk = hasPrev ? parseFloat(cml.MIN_PREVIOUS) : null;
        const intermediateThk = hasIntermediate ? parseFloat(cml.MIN_INTERMEDIATE) : null;
        const currentThk = hasCurrent ? parseFloat(cml.MIN_CURRENT) : null;

        // Corrosion Rates
        const stcrVal = cml.STCR;
        const ltcrVal = cml.LTCR;
        const isBaseline = !stcrVal || String(stcrVal).includes('Baseline') || String(stcrVal).includes('N/A');
        const stcrNum = isBaseline ? 0 : (parseFloat(stcrVal) || 0);
        const ltcrNum = parseFloat(ltcrVal) || 0;

        // Nozzle & Dual T-Min extraction
        const isNozzle = (cml.EV_COMPONENT === 'Nozzle' || (cml.FV_COMPONENT && cml.FV_COMPONENT.includes('Nozzle')));
        
        const matchStruct = (cml.UG_45_COMPARE || '').toString().match(/\(([\d.]+)\)/);
        const tMinStructural = matchStruct ? parseFloat(matchStruct[1]) : (parseFloat(cml.UG_45_COMPARE) || null);
        
        const matchPres = (cml.UG_27_NOZZLE || '').toString().match(/\(([\d.]+)\)/);
        const tMinPressure = matchPres ? parseFloat(matchPres[1]) : (parseFloat(cml.UG_27_NOZZLE) || null);
        const sequenceId = formatVal(cml.AT_SEQ_NUMBER);

        // Evaluate Status
        if (currentThk < tMin) {
            criticalsCount++;
        } else if (currentThk <= tMin * 1.1 || (stcrNum > 0.005)) {
            cautionsCount++;
        }

        const installYear = cml.YEAR_BASE || cml.EV_BLD_YEAR || cml.SUB_BUILD_YEAR || cml.DB_BLD_YEAR || 'N/A';
        const prevYear = cml.YEAR_PREVIOUS || 'N/A';
        const currentYear = rawData.EV_EVENT_DATE ? rawData.EV_EVENT_DATE.substring(0, 4) : (rawData.EVENT_DATE ? rawData.EVENT_DATE.substring(0, 4) : 'N/A');
        const concatId = cml.EV_CML_CONCAT_NUMBER || '';
        const inspectorComments = formatVal(cml.COMMENTS_RECONCILED);
        const remLife = formatVal(cml.REMAIN_LIFE);
        const interval = formatVal(cml.NEXT_INSP_DATE);
        const complianceStatus = formatVal(cml.COMPLIANCE_STATUS || 'Meets minimal thickness criteria for continued service');
        
        const baseYearLabel = cml.YEAR_BASE || '';
        const prevYearLabel = cml.YEAR_PREVIOUS || '';
        const interYearLabel = cml.YEAR_INTERMEDIATE || '';
        let currYearLabel = '';
        if (cml.CLEAN_DATE) {
            const match = String(cml.CLEAN_DATE).match(/\d{4}/);
            currYearLabel = match ? match[0] : String(cml.CLEAN_DATE);
        }

        const chartLabels = {
            base: baseYearLabel ? `Base (${baseYearLabel})` : 'Base',
            prev: prevYearLabel ? `Previous (${prevYearLabel})` : 'Previous',
            inter: interYearLabel ? `Inter. (${interYearLabel})` : 'Inter.',
            curr: currYearLabel ? `Current (${currYearLabel})` : 'Current'
        };
        
        // Component Name already extracted above

        let tMinCalcLabel = 'CALCULATION';
        let tMinCalcValue = 'N/A';
        if (componentName === 'Piping') {
            tMinCalcLabel = 'B31.3 PIPING CALCULATION';
            tMinCalcValue = cml.B313_PIPING_CALCULATION;
        } else if (componentName === 'Shell') {
            tMinCalcLabel = 'ASME - UG-27 SHELL CALCULATION';
            tMinCalcValue = cml.UG_27_SHELL;
        } else if (componentName === 'Top Head') {
            tMinCalcLabel = 'ASME - UG-32 TOP HEAD CALCULATION';
            tMinCalcValue = cml.UG_32_TOP;
        } else if (componentName === 'Bottom Head') {
            tMinCalcLabel = 'ASME - UG-32 BOTTOM HEAD CALCULATION';
            tMinCalcValue = cml.UG_32_BOTTOM;
        } else if (componentName === 'Nozzle') {
            tMinCalcLabel = 'ASME - UG-27 NOZZLE CALCULATION';
            tMinCalcValue = cml.UG_27_NOZZLE;
        }

        const formatDualCML = (val) => {
            let v = parseFloat(val);
            if (isNaN(v)) return formatVal(val);
            let mm = (v * 25.4).toFixed(3);
            if (mm.endsWith('00')) mm = (v * 25.4).toFixed(1);
            return v.toFixed(3) + ' / ' + mm;
        };

        const updatedCardDetails = [
            { label: 'UNIQUE CML NUMBER', value: formatVal(cml.EV_CML_CONCAT_NUMBER) },
            { label: 'COMPONENT TYPE', value: formatVal(cml.EV_COMPONENT) },
            { label: 'CODE SPECIFICATION', value: formatVal(cml.EV_SPEC) },
            { label: 'RT / JOINT EFFICIENCY', value: formatVal(cml.EV_SHELL_EFF || cml.FV_SHELL_EFF) },
            { label: 'COMPONENT SHAPE', value: formatVal(cml.EV_COMPONENT_SHAPE) },
            { label: 'OD (INCH/MM)', value: formatDualCML(cml.EV_OUT_DIA) },
            { label: 'NOMINAL THICKNESS (INCH/MM)', value: formatDualCML(cml.EV_NOM_THK) },
            { label: 'CORROSION ALLOWANCE (INCH/MM)', value: formatDualCML(cml.EV_COR_ALLOW) },
            { label: 'MAWP (KPA/PSI)', value: (cml.EV_MAWP_KPA || cml.EV_MAWP) ? `${formatVal(cml.EV_MAWP_KPA)} / ${formatVal(cml.EV_MAWP)}` : 'N/A' },
            { label: 'MAWT (C/F)', value: (cml.EV_MAWT_C || cml.EV_MAWT) ? `${formatVal(cml.EV_MAWT_C)} / ${formatVal(cml.EV_MAWT)}` : 'N/A' },
            { label: 'BUILD YEAR', value: formatVal(cml.EV_BLD_YEAR) },
            { label: 'FV - MATERIAL TYPE', value: formatVal(cml.FV_MATERIAL) },
            { label: 'T-MIN (' + tMinCalcLabel + ')', value: formatVal(tMinCalcValue) },
            { label: 'BASELINE MINIMUM', value: formatVal(cml.MIN_BASE) },
            { label: 'ACTUAL THICKNESS', value: formatVal(cml.MIN_CURRENT) },
            { label: 'COMPONENT NOMINAL THICKNESS (INCH)', value: formatVal(cml.EV_NOM_THK) },
            { label: 'LONG TERM CORROSION RATE', value: formatVal(cml.LTCR) },
            { label: 'SHORT TERM CORROSION RATE', value: formatVal(cml.STCR) },
            { label: 'VESSEL TMIN COMPARISON', value: formatVal(cml.COMPLIANCE_STATUS) },
            { label: 'PRESSURE PIPING PRESSURE TMIN VALIDATION', value: formatVal(cml.PIPE_COMPLIANCE || 'N/A') },
            { label: 'PREVIOUS COMMENTS', value: formatVal(cml.PREVIOUS_COMMENTS) },
            { label: 'NEXT INSPECTION DATE', value: formatVal(cml.NEXT_INSP_DATE) },
            { label: 'REMAINING LIFE', value: formatVal(cml.REMAIN_LIFE) },
            { label: 'RETIREMENT DATE', value: formatVal(cml.RETIREMENT_DATE) },
            { label: 'COUPLANT TYPE', value: formatVal(cml.COUPLANT) },
            { label: 'SURFACE CONDITION', value: formatVal(cml.SURFACE_COND) },
            { label: 'SCAN TYPE', value: formatVal(cml.SCAN_TYPE) }
        ];

    
    // Scope Data Group
    const scopeData = [
        { label: 'Corrosion Survey Scope', value: formatVal(rawData.SCOPE) },
        { label: 'Corrosion Survey Method', value: formatVal(rawData.METHOD) },
        { label: 'Corrosion Survey Calibration', value: formatVal(rawData.METHOD_1) },
        { label: 'Corrosion Survey Instrument Settings', value: formatVal(rawData.METHOD_2) },
        { label: 'Corrosion Survey Special Equipment', value: formatVal(rawData.METHOD_3) },
        { label: 'Corrosion Survey Acceptance', value: formatVal(rawData.METHOD_4) }
    ];

            let statusColor = '#6b7280';
            let statusText = cml.CML_STATUS || 'UNKNOWN';
            if (statusText.toLowerCase().includes('consumed') || statusText.toLowerCase().includes('below') || statusText.toLowerCase().includes('measurable loss')) {
                statusColor = '#d97706';
            }
            let trendText = cml.CORROSION_TREND || 'UNKNOWN';

            let tminDisplay = tMinRaw !== null && tMinRaw !== undefined ? tMinRaw : 'N/A';

            let retDateDisplay = cml.RETIREMENT_DATE || 'N/A';
            if (retDateDisplay.length > 15 && cml.TMIN_DATE) {
                retDateDisplay = cml.TMIN_DATE.split(' ')[0]; 
            }

            let nextInspDisplay = cml.NEXT_INSP_DATE || 'N/A';
            if (nextInspDisplay.includes('TBD')) nextInspDisplay = 'TBD';

            let compStatHtml = cml.COMPLIANCE_STATUS || 'N/A';
            compStatHtml = compStatHtml.replace(/✅ ACCEPTABLE:/, '<strong class="cml-stat-acceptable">Acceptable</strong> &mdash;');
            compStatHtml = compStatHtml.replace(/🚨 RETIREMENT:/, '<strong class="cml-stat-retirement">Retirement</strong> &mdash;');
            compStatHtml = compStatHtml.replace(/❗/, '');

            const v50 = {
                statusColor,
                statusText,
                trendText,
                tminDisplay,
                retDateDisplay,
                nextInspDisplay,
                compStatHtml
            };

            return {
            index: idx + 1,
            cmlNumber: formatVal(cml.EV_CML_NUMBER || cml.FV_CML_NUMBER),
            concatId: formatVal(concatId),
            description: formatVal(cml.FV_CML_DESCRIPTION),
            location: formatVal(cml.SHELL_LOCATION),
            componentName,
            photo: cmlPhoto,
            cardDetails: updatedCardDetails,
            chartLabels,
            tMin,
            isNozzle,
            tMinStructural,
            tMinPressure,
            sequenceId,
            hasBase,
            hasPrev,
            hasIntermediate,
            hasCurrent,
            nomThk,
            componentNominal: parseFloat(cml.COMPONENT_NOMINAL) || nomThk,
            installThk,
            prevThk,
            intermediateThk,
            currentThk,
            isBaseline,
            stcrVal: formatVal(stcrVal),
            ltcrVal: formatVal(ltcrVal),
            stcrNum,
            ltcrNum,
            remLife,
            interval,
            installYear,
            prevYear,
            currentYear,
            inspectorComments,
            complianceStatus,
            rawCml: cml,
            v50: v50
        };
    });

    // Scorecard Summary
    const scorecard = {
        totalCml: processedCMLs.length,
        cautions: cautionsCount,
        criticals: criticalsCount
    };

    // Extract Global Spec
    const globalFvSpec = cmlList.length > 0 && cmlList[0].FV_SPEC 
        ? formatVal(cmlList[0].FV_SPEC) 
        : 'ASME Section VIII, Div 1';

    // Page 2: Vessel Overview Data Group
    const overviewDataRaw = [
        { key: 'DB_OUT_DIAMETER', fallback: 'EV_OUT_DIAMETER' },
        { key: 'EV_SHELL_1', fallback: null },
        { key: 'FV_BOTTOM_MATERIAL', fallback: 'EV_BOTTOM_MATERIAL' },
        { key: 'FV_TOP_MATERIAL_STRESS', fallback: 'EV_TOP_MATERIAL_STRESS' },
        { key: 'EV_TOP_SHAPE', fallback: null },
        { key: 'EV_BOTTOM_SHAPE', fallback: null }
    ];

    const overviewData = overviewDataRaw.map(item => {
        let val = formatVal(rawData[item.key]);
        if (val === 'N/A' && item.fallback) {
            val = formatVal(rawData[item.fallback]);
        }
    
    // Scope Data Group
    const scopeData = [
        { label: 'Corrosion Survey Scope', value: formatVal(rawData.SCOPE) },
        { label: 'Corrosion Survey Method', value: formatVal(rawData.METHOD) },
        { label: 'Corrosion Survey Calibration', value: formatVal(rawData.METHOD_1) },
        { label: 'Corrosion Survey Instrument Settings', value: formatVal(rawData.METHOD_2) },
        { label: 'Corrosion Survey Special Equipment', value: formatVal(rawData.METHOD_3) },
        { label: 'Corrosion Survey Acceptance', value: formatVal(rawData.METHOD_4) }
    ];

    return {
            key: item.key,
            label: getLabel(item.key),
            value: val
        };
    }).filter(item => item.value !== 'N/A');

    // Lease Page Data (Page 3)
    const leaseData = [
        { label: 'Area Name', value: formatVal(rawData.EV_LOCATION_2) },
        { label: 'Field Name', value: formatVal(rawData.EV_LOCATION_3) },
        { label: 'Surface Location', value: formatVal(rawData.EV_SURFACE_3) },
        { label: 'Facility Type', value: formatVal(rawData.EV_SURFACE_2) },
        { label: 'Integrity Package/Skid Number', value: formatVal(rawData.EV_PKG_1) },
        { label: 'Foreman Name', value: formatVal(rawData.EV_LOCATION_4) }
    ].filter(item => item.value !== 'N/A');

    // Page 3: Nameplate Data Group
    const nameplateData = [
        { label: 'Integrity Tag Number', value: formatVal(rawData.EV_TAGGING_4 || rawData.EV_TAGGING_1) },
        { label: 'Registration Number', value: formatVal(rawData.EV_REG_1) },
        { label: 'Manufacturer Serial Number', value: formatVal(rawData.EV_MANU_1) },
        { label: 'Manufacturer CRN', value: formatVal(rawData.EV_MANU_2) },
        { label: 'Equipment Manufacturer', value: formatVal(rawData.EV_MANU_3) },
        { label: 'Radiography', value: formatVal(rawData.EV_TREAT_1) },
        { label: 'Build Year', value: formatVal(rawData.EV_BLD_YEAR) },
        { label: 'ASME Code', value: formatVal(rawData.EV_MANU_6) },
        { label: 'MAWP (psi/kPa)', value: (rawData.EV_INTERNAL_MAWP_PSI_1 || rawData.EV_INT_PRESS_kPA_1) ? `${formatVal(rawData.EV_INTERNAL_MAWP_PSI_1)} / ${formatVal(rawData.EV_INT_PRESS_kPA_1)}` : 'N/A' },
        { label: 'MAWT (°F/°C)', value: (rawData.EV_MAWT_F_1 || rawData.EV_MAWT_C_1) ? `${formatVal(rawData.EV_MAWT_F_1)} / ${formatVal(rawData.EV_MAWT_C_1)}` : 'N/A' },
        { label: 'MDMT (°F/°C)', value: (rawData.EV_MAWT_F_2 || rawData.EV_MAWT_C_2) ? `${formatVal(rawData.EV_MAWT_F_2)} / ${formatVal(rawData.EV_MAWT_C_2)}` : 'N/A' },
        { label: 'Allowance (in/mm)', value: (rawData.EV_CA_inch || rawData.EV_CA_mm) ? `${formatVal(rawData.EV_CA_inch)} / ${formatVal(rawData.EV_CA_mm)}` : 'N/A' }
    ];

    // Page 4: Site & Location Data Group (empty in this template version, leaving empty)
    const locationData = [];

    const formatDual = (val) => {
        let v = parseFloat(val);
        if (isNaN(v)) return formatVal(val);
        let mm = (v * 25.4).toFixed(3);
        if (mm.endsWith('00')) mm = (v * 25.4).toFixed(1);
        return v.toFixed(3) + ' / ' + mm;
    };

    const overviewDataFormatted = [
        {
            heading: 'Dimensions',
            items: [
                { label: 'OD (inch/mm)', value: formatDual(rawData.DB_OUT_DIAMETER || rawData.EV_OUT_DIAMETER) },
                { label: 'Length (inch/mm)', value: formatDual(rawData.EV_DIM_INCH_2 || rawData.DB_DIM_INCH_2) },
                { label: 'Height (inch/mm)', value: formatDual(rawData.EV_DIM_INCH_3 || rawData.DB_DIM_INCH_3) }
            ].filter(i => i.value !== 'N/A')
        },
        {
            heading: 'Top/Left Head',
            items: [
                { label: 'Shape', value: formatVal(rawData.EV_TOP_SHAPE || rawData.DB_TOP_SHAPE) },
                { label: 'Material', value: formatVal(rawData.EV_TOP_MATERIAL_STRESS || rawData.FV_TOP_MATERIAL_STRESS) },
                { label: 'Nominal Thickness (inch/mm)', value: formatDual(rawData.EV_TL_THK_1 || rawData.DB_TL_THK_1) }
            ].filter(i => i.value !== 'N/A')
        },
        {
            heading: 'Shell',
            items: [
                { label: 'Material', value: formatVal(rawData.EV_SHELL_1 || rawData.DB_SHELL_1) },
                { label: 'Nominal Thickness (inch/mm)', value: formatDual(rawData.EV_SHELL_INCH_1 || rawData.DB_SHELL_INCH_1) }
            ].filter(i => i.value !== 'N/A')
        },
        {
            heading: 'Bottom/Right Head',
            items: [
                { label: 'Shape', value: formatVal(rawData.EV_BOTTOM_SHAPE || rawData.DB_BOTTOM_SHAPE) },
                { label: 'Material', value: formatVal(rawData.EV_BOTTOM_MATERIAL || rawData.FV_BOTTOM_MATERIAL) },
                { label: 'Nominal Thickness (inch/mm)', value: formatDual(rawData.EV_BRT_1 || rawData.DB_BRT_1) }
            ].filter(i => i.value !== 'N/A')
        }
    ].filter(section => section.items.length > 0);

    const examinerData = [
        { label: 'Examiner', value: formatVal(rawData.EXAMINER || rawData.INSP_NAME) },
        { label: 'CGSB UT Number', value: formatVal(rawData.EXAMINER_1) },
        { label: 'CGSB UT Level', value: formatVal(rawData.EXAMINER_2) },
        { label: 'ASNT UT Number', value: formatVal(rawData.EXAMINER_3) },
        { label: 'ASNT UT Level', value: formatVal(rawData.EXAMINER_4) }
    ].filter(i => i.value !== 'N/A');


    // Scope Data Group
    const scopeData = [
        { label: 'Corrosion Survey Scope', value: formatVal(rawData.SCOPE) },
        { label: 'Corrosion Survey Method', value: formatVal(rawData.METHOD) },
        { label: 'Corrosion Survey Calibration', value: formatVal(rawData.METHOD_1) },
        { label: 'Corrosion Survey Instrument Settings', value: formatVal(rawData.METHOD_2) },
        { label: 'Corrosion Survey Special Equipment', value: formatVal(rawData.METHOD_3) },
        { label: 'Corrosion Survey Acceptance', value: formatVal(rawData.METHOD_4) }
    ];

    return {
        formVersion: parseInt(rawData.formVersion, 10) || 0,
        headerData,
        coverData,
        ndtTableData,
        scorecard,
        globalFvSpec,
        overviewData: overviewDataFormatted,
        examinerData,
        nameplateData,
        locationData,
        leaseData,
        processedCMLs,
        finalReport,
        scopeData,
        headerLogo,
        headerText,
        headerLine,
        overImg,
        nameImg,
        isoImages,
        leaseImg,
        bldImg,
        sigImg,
        sigChiefImg,
        certAt1,
        certAt2,
        certNrcanFront,
        certNrcanBack,
        getLabel,
        formatVal
    };
}

module.exports = { processReportData };
