/*
 * Authorized PDF Watermark Cleanup — v3
 * Browser-only / GitHub Pages compatible.
 *
 * Safety model:
 *  - Only allowlisted watermark/domain signatures are eligible.
 *  - The original upload is never changed.
 *  - Page content streams AND Form XObjects are inspected.
 *  - TJ arrays are handled conservatively: mixed-content arrays are not removed.
 *  - Images/pixels are never erased or rasterized.
 *  - A second scan verifies that eligible signatures are gone before download.
 *
 * IMPORTANT: Use only for PDFs you own or are authorized to modify.
 */
(() => {
  'use strict';

  const {
    PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, PDFRef, decodePDFRawStream,
  } = PDFLib;

  const CONFIG = {
    maxFileBytes: 120 * 1024 * 1024,
    maxXObjectDepth: 12,
    targets: [
      {
        id: 'tamilguru', label: 'TamilGuru.lk',
        terms: ['tamilguru.lk', 'www.tamilguru.lk', 'more past papers at tamilguru.lk', 'more past papers at'],
        hexSignatures: [
          '00300052005500480003003300440056005700030033004400530048005500560003004400570003005700440050004C004F004A0058005500580011004F004E',
          '00300052005500480003003300440056005700030033004400530048005500560003004400570003005700440050004C004F004A0058005500580011004F004E',
          '005700440050004C004F004A0058005500580011004F004E',
        ],
      },
      { id: 'pastpaperswiki', label: 'PastPapers.Wiki', terms: ['pastpapers.wiki', 'www.pastpapers.wiki'], hexSignatures: [] },
      { id: 'ekalvi', label: 'e-kalvi.com', terms: ['e-kalvi.com', 'ekalvi.com', 'www.e-kalvi.com'], hexSignatures: [] },
      { id: 'alevelapi', label: 'AlevelAPI.com', terms: ['alevelapi.com', 'www.alevelapi.com', 'a level api.com'], hexSignatures: [] },
      { id: 'gurupiyasa', label: 'GuruPiyasa.guru', terms: ['gurupiyasa.guru', 'www.gurupiyasa.guru'], hexSignatures: [] },
    ],
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    file: $('pdfFile'), drop: $('dropZone'), browse: $('browseBtn'), reset: $('resetBtn'), download: $('downloadBtn'),
    fileMeta: $('fileMeta'), status: $('statusPill'), empty: $('emptyState'), progressWrap: $('progressWrap'),
    progressLabel: $('progressLabel'), progressPercent: $('progressPercent'), progressBar: $('progressBar'),
    summary: $('summary'), statPages: $('statPages'), statAffected: $('statAffected'), statHits: $('statHits'),
    statSize: $('statSize'), brandSummary: $('brandSummary'), pageList: $('pageList'), result: $('resultBox'),
    resultText: $('resultText'), error: $('errorBox'), preview: $('previewBox'), previewTitle: $('previewTitle'),
    previewBody: $('previewBody'), verifyBox: $('verifyBox'), verifyText: $('verifyText'),
  };

  let selectedFile = null;
  let sourceBytes = null;
  let cleanedBytes = null;
  let outputUrl = null;
  let busy = false;
  let lastAnalysis = null;

  const sleep = () => new Promise((resolve) => setTimeout(resolve, 0));

  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    const units = ['B', 'KB', 'MB', 'GB']; let value = bytes; let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return `${value.toFixed(i === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
  }
  function bytesToLatin1(bytes) {
    let s = ''; const chunk = 16384;
    for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return s;
  }
  function cleanHex(hex) { return String(hex || '').replace(/\s+/g, '').toUpperCase(); }
  function hexToBytes(hex) {
    const n = cleanHex(hex); if (!n || n.length % 2 || /[^0-9A-F]/.test(n)) return null;
    const out = new Uint8Array(n.length / 2);
    for (let i = 0; i < n.length; i += 2) out[i / 2] = parseInt(n.slice(i, i + 2), 16);
    return out;
  }
  function normalizeText(text) {
    return String(text || '').toLowerCase().replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function findTargetInText(text) {
    const lower = normalizeText(text); if (!lower) return null;
    for (const target of CONFIG.targets) for (const term of target.terms) if (lower === term || lower.includes(term)) return target;
    return null;
  }
  function exactTargetInText(text) {
    const lower = normalizeText(text); if (!lower) return null;
    for (const target of CONFIG.targets) for (const term of target.terms) if (lower === term) return target;
    return null;
  }
  function decodePdfLiteral(raw) {
    if (!raw || raw[0] !== '(') return '';
    let body = raw.slice(1, -1);
    return body.replace(/\\\r?\n/g, '').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
      .replace(/\\b/g, '\b').replace(/\\f/g, '\f').replace(/\\([()\\])/g, '$1')
      .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8) & 255));
  }
  function targetFromHexOperand(hex) {
    const n = cleanHex(hex); if (!n) return null;
    for (const target of CONFIG.targets) if (target.hexSignatures.some((sig) => n.includes(sig))) return target;
    const bytes = hexToBytes(n); if (!bytes) return null;
    let found = findTargetInText(bytesToLatin1(bytes)); if (found) return found;
    if (bytes.length % 2 === 0) {
      const codes = []; for (let i = 0; i < bytes.length; i += 2) codes.push((bytes[i] << 8) | bytes[i + 1]);
      // Some scanned-paper watermarks use a simple two-byte custom encoding: ASCII
      // code points are stored as UTF-16BE and 0003 is used as a word separator.
      // Decode those code points before falling back to the legacy shifted-font scan.
      const direct = codes.map((c) => c === 3 ? ' ' : (c >= 32 && c < 127 ? String.fromCharCode(c) : '?')).join('');
      found = findTargetInText(direct); if (found) return found;
      // Keep the legacy shifted-font detector, but require an exact target match.
      for (let shift = -64; shift <= 64; shift += 1) {
        let candidate = ''; for (const c of codes) { const v = c + shift; candidate += v >= 32 && v < 127 ? String.fromCharCode(v) : '?'; }
        found = exactTargetInText(candidate); if (found) return found;
      }
    }
    return null;
  }
  function targetFromOperand(op) {
    if (!op) return null;
    if (op[0] === '<') return targetFromHexOperand(op.slice(1, -1));
    if (op[0] === '(') return exactTargetInText(decodePdfLiteral(op));
    return null;
  }

  // A small PDF content tokenizer. It understands comments, literal strings,
  // hex strings, arrays and names/numbers, so parentheses inside PDF strings
  // do not break detection.
  function tokenizePdf(content) {
    const tokens = []; let i = 0; const len = content.length;
    const isWs = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\0';
    while (i < len) {
      while (i < len && isWs(content[i])) i += 1;
      if (i >= len) break;
      if (content[i] === '%') { while (i < len && content[i] !== '\n' && content[i] !== '\r') i += 1; continue; }
      const start = i, c = content[i];
      if (c === '(') {
        i += 1; let depth = 1;
        while (i < len && depth) {
          if (content[i] === '\\') { i += 2; continue; }
          if (content[i] === '(') depth += 1;
          else if (content[i] === ')') depth -= 1;
          i += 1;
        }
        tokens.push({ type:'string', raw:content.slice(start, i), start, end:i }); continue;
      }
      if (c === '<' && content[i + 1] !== '<') {
        i += 1; while (i < len && content[i] !== '>') i += 1; if (i < len) i += 1;
        tokens.push({ type:'hex', raw:content.slice(start, i), start, end:i }); continue;
      }
      if (c === '[') { tokens.push({ type:'arrayStart', raw:c, start, end:++i }); continue; }
      if (c === ']') { tokens.push({ type:'arrayEnd', raw:c, start, end:++i }); continue; }
      if (c === '<' && content[i + 1] === '<') { tokens.push({ type:'word', raw:'<<', start, end:i += 2 }); continue; }
      if (c === '>' && content[i + 1] === '>') { tokens.push({ type:'word', raw:'>>', start, end:i += 2 }); continue; }
      while (i < len && !isWs(content[i]) && !'[]()<>%'.includes(content[i])) i += 1;
      tokens.push({ type:'word', raw:content.slice(start, i), start, end:i });
    }
    return tokens;
  }

  function tokenText(token) {
    if (!token) return '';
    if (token.type === 'string') return decodePdfLiteral(token.raw);
    if (token.type === 'hex') {
      const b = hexToBytes(token.raw.slice(1, -1)); return b ? bytesToLatin1(b) : '';
    }
    return '';
  }

  function analyzeContent(content, remove) {
    const tokens = tokenizePdf(content); const replacements = []; const hits = []; let i = 0;
    const addHit = (target, token, kind) => { if (!target) return; hits.push({ target, kind, start: token.start, end: token.end }); };
    const isShowOp = (raw) => raw === 'Tj' || raw === 'TJ' || raw === "'" || raw === '"';

    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === 'arrayStart') {
        let depth = 1, j = i + 1;
        while (j < tokens.length && depth) { if (tokens[j].type === 'arrayStart') depth += 1; if (tokens[j].type === 'arrayEnd') depth -= 1; j += 1; }
        const close = j - 1, op = tokens[j];
        if (depth === 0 && op && op.type === 'word' && op.raw === 'TJ') {
          const stringTokens = tokens.slice(i + 1, close).filter((x) => x.type === 'string' || x.type === 'hex');
          const joined = stringTokens.map(tokenText).join('');
          const target = targetFromHexOperand(stringTokens.length === 1 && stringTokens[0].type === 'hex' ? stringTokens[0].raw.slice(1,-1) : '') || findTargetInText(joined);
          if (target && stringTokens.length && normalizeText(joined).includes(target.terms[0])) {
            // Safest rule: only remove the entire TJ operation when ALL textual
            // content in it is the watermark. Numbers (kerning) are retained by
            // replacing the array with [] so no neighbouring text disappears.
            const allTextIsWatermark = stringTokens.every((x) => {
              const txt = tokenText(x); return !txt || normalizeText(txt) === target.terms[0] || targetFromOperand(x.raw) === target;
            });
            if (allTextIsWatermark || normalizeText(joined) === target.terms[0]) {
              addHit(target, t, 'TJ array');
              replacements.push({ start: t.start, end: op.end, text: '[] TJ' });
            }
          }
          i = j; continue;
        }
      }
      if ((t.type === 'string' || t.type === 'hex') && tokens[i + 1]?.type === 'word' && isShowOp(tokens[i + 1].raw)) {
        const target = targetFromOperand(t.raw);
        if (target) {
          addHit(target, t, tokens[i + 1].raw);
          // For the spacing operators, preserve the operator but blank only the
          // target string. For Tj / ' this yields no target glyphs.
          replacements.push({ start: t.start, end: t.end, text: '()' });
        }
      }
      // Double quote operator: aw ac string "
      if ((t.type === 'string' || t.type === 'hex') && tokens[i + 1]?.type === 'word' && tokens[i + 1].raw === '"') {
        const target = targetFromOperand(t.raw); if (target) { addHit(target, t, '"'); replacements.push({ start:t.start, end:t.end, text:'()' }); }
      }
      i += 1;
    }
    if (!remove || !replacements.length) return { text:content, hits, modified:false };
    replacements.sort((a,b) => b.start - a.start);
    let out = content; for (const r of replacements) out = out.slice(0,r.start) + r.text + out.slice(r.end);
    return { text:out, hits, modified:out !== content };
  }

  function mergeCounts(into, from) { for (const [k,v] of Object.entries(from || {})) into[k] = (into[k] || 0) + v; }
  function brandCountsFromHits(hits) { const out={}; for (const h of hits) if (h.target) out[h.target.id]=(out[h.target.id]||0)+1; return out; }

  function getResources(doc, node) {
    const raw = node.get(PDFName.of('Resources')); if (!raw) return null;
    return doc.context.lookup(raw);
  }
  function getXObjectDict(doc, resources) {
    if (!(resources instanceof PDFDict)) return null;
    const raw = resources.get(PDFName.of('XObject')); if (!raw) return null;
    const x = doc.context.lookup(raw); return x instanceof PDFDict ? x : null;
  }
  function streamEntries(doc, node) {
    const raw = node.get(PDFName.of('Contents')); if (!raw) return [];
    const resolved = doc.context.lookup(raw); const out=[];
    if (resolved instanceof PDFArray) {
      for (let i=0;i<resolved.size();i++) { const child=resolved.get(i), stream=doc.context.lookup(child); if (stream instanceof PDFRawStream) out.push({stream,ref:child instanceof PDFRef?child:null,array:resolved,index:i,node}); }
    } else if (resolved instanceof PDFRawStream) out.push({stream:resolved,ref:raw instanceof PDFRef?raw:null,array:null,index:null,node});
    return out;
  }
  function replaceEntry(doc, entry, text) {
    const ns=doc.context.flateStream(text);
    if (entry.ref) doc.context.assign(entry.ref, ns);
    else if (entry.array) entry.array.set(entry.index, ns);
    else entry.node.set(PDFName.of('Contents'), ns);
  }
  function decodeStream(stream) { return bytesToLatin1(decodePDFRawStream(stream).decode()); }

  function scanNode(doc, node, remove, state, location, depth=0) {
    if (!node || depth > CONFIG.maxXObjectDepth) return;
    const key = node instanceof PDFRef ? String(node.objectNumber) + ':' + String(node.generationNumber) : null;
    if (key && state.visited.has(key)) return; if (key) state.visited.add(key);

    for (const entry of streamEntries(doc,node)) {
      let content; try { content=decodeStream(entry.stream); } catch { state.unsupportedStreams += 1; continue; }
      const result=analyzeContent(content,remove); if (!result.hits.length) continue;
      state.totalHits += result.hits.length; mergeCounts(state.brandCounts,brandCountsFromHits(result.hits));
      state.locations.push({page:location.page, type:location.type, name:location.name || '', hits:result.hits.length, brands:brandCountsFromHits(result.hits)});
      if (remove && result.modified) replaceEntry(doc,entry,result.text);
    }

    const resources=getResources(doc,node), xdict=getXObjectDict(doc,resources); if (!xdict) return;
    for (const [nameRef, valueRef] of xdict.entries()) {
      const obj=doc.context.lookup(valueRef); if (!(obj instanceof PDFRawStream)) continue;
      const subtype=obj.dict.get(PDFName.of('Subtype')); const subtypeName=subtype?.decodeText?.() || '';
      if (subtypeName !== 'Form') continue;
      scanNode(doc,obj,remove,state,{page:location.page,type:'Form XObject',name:nameRef.decodeText?.() || String(nameRef)},depth+1);
    }
  }

  async function scanPdf(bytes, remove=false, prefix='Analyzing') {
    const doc=await PDFDocument.load(new Uint8Array(bytes),{updateMetadata:false,ignoreEncryption:false});
    const pages=doc.getPages(); const state={totalHits:0,brandCounts:{},locations:[],visited:new Set(),unsupportedStreams:0};
    const pageResults=[];
    for (let p=0;p<pages.length;p++) {
      setProgress(`${prefix} page ${p+1} of ${pages.length}…`,p,pages.length);
      const before=state.totalHits; const pageBrandBefore={...state.brandCounts};
      scanNode(doc,pages[p].node,remove,state,{page:p+1,type:'Page'});
      const pageHits=state.totalHits-before; const pageBrands={};
      for (const [k,v] of Object.entries(state.brandCounts)) pageBrands[k]=v-(pageBrandBefore[k]||0);
      pageResults.push({page:p+1,hits:pageHits,brandCounts:pageBrands});
      if (p%5===0) await sleep();
    }
    setProgress(remove?'Saving cleaned PDF…':'Analysis complete',pages.length,pages.length);
    if (!remove) return {pageCount:pages.length,totalHits:state.totalHits,pages:pageResults,brandCounts:state.brandCounts,locations:state.locations,unsupportedStreams:state.unsupportedStreams};
    const out=await doc.save({useObjectStreams:true,addDefaultPage:false,objectsPerTick:50});
    return {pageCount:pages.length,totalHits:state.totalHits,pages:pageResults,brandCounts:state.brandCounts,locations:state.locations,unsupportedStreams:state.unsupportedStreams,bytes:out};
  }

  function setProgress(label,done,total){ els.progressWrap.classList.remove('hidden'); els.progressLabel.textContent=label; const pct=total?Math.round(done/total*100):0; els.progressPercent.textContent=`${pct}%`; els.progressBar.style.width=`${pct}%`; }
  function hideProgress(){els.progressWrap.classList.add('hidden');}
  function setStatus(text,state){els.status.textContent=text;els.status.className=`status-pill ${state}`;}
  function setBusy(v){busy=v;els.browse.disabled=v;els.reset.disabled=v;}
  function clearMessages(){els.error.classList.add('hidden');els.error.textContent='';els.result.classList.add('hidden');els.download.disabled=true;els.resultText.textContent='';els.verifyBox.classList.add('hidden');els.verifyText.textContent='';}
  function showError(m){els.error.textContent=m;els.error.classList.remove('hidden');}
  function normalizeError(error){const m=String(error?.message||error||'Unknown error');if(/encrypted|password/i.test(m))return'This PDF is password-protected or encrypted. Please use an unlocked PDF.';if(/Invalid PDF|Missing PDF|header/i.test(m))return'The selected file could not be read as a valid PDF.';return`Could not process this PDF: ${m}`;}
  function brandLabel(id){return CONFIG.targets.find(t=>t.id===id)?.label||id;}
  function describeCounts(counts){const e=Object.entries(counts||{}).filter(([,v])=>v>0);return e.length?e.sort((a,b)=>b[1]-a[1]).map(([id,c])=>`<strong>${escapeHtml(brandLabel(id))}</strong>: ${c}`).join(' &nbsp;•&nbsp; '):'No configured watermark signature was detected.';}
  function renderSummary(result,outBytes){const affected=result.pages.filter(p=>p.hits).length;els.empty.classList.add('hidden');els.summary.classList.remove('hidden');els.pageList.classList.remove('hidden');els.brandSummary.classList.remove('hidden');els.statPages.textContent=result.pageCount;els.statAffected.textContent=affected;els.statHits.textContent=result.totalHits;els.statSize.textContent=fmtBytes(outBytes?.byteLength||selectedFile?.size||0);els.brandSummary.innerHTML=`<strong>Detected:</strong> ${describeCounts(result.brandCounts)}${result.unsupportedStreams?`<br><span class="warn-line">${result.unsupportedStreams} content stream(s) could not be decoded and were left untouched.</span>`:''}`;els.pageList.innerHTML=result.pages.map(p=>`<div class="page-row"><strong>Page ${p.page}</strong><span class="badge ${p.hits?'hit':'clear'}">${p.hits?'MATCHED':'CLEAR'}</span><span class="page-note">${p.hits?`${p.hits} allowlisted watermark object${p.hits===1?'':'s'}`:'No allowlisted text watermark match'}</span></div>`).join('');}
  function renderPreview(result){
    els.preview.classList.remove('hidden');
    if (!result.totalHits) { els.previewTitle.textContent='Detection preview'; els.previewBody.innerHTML='<p class="muted">No allowlisted watermark object was detected. No automatic changes will be made.</p>'; return; }
    const rows=result.locations.slice(0,60).map((x)=>`<div class="candidate-row"><span class="candidate-page">Page ${x.page}</span><span class="candidate-type">${escapeHtml(x.type)}${x.name?` · ${escapeHtml(x.name)}`:''}</span><span class="candidate-brand">${Object.keys(x.brands).map(brandLabel).map(escapeHtml).join(', ')}</span><span class="candidate-confidence">HIGH</span></div>`).join('');
    els.previewTitle.textContent=`Detected watermark objects (${result.totalHits})`;
    els.previewBody.innerHTML=`<div class="preview-note">Only these allowlisted text objects are eligible. Images and the main page artwork are not pixel-erased.</div>${rows}`;
  }
  function clearOutputUrl(){if(outputUrl)URL.revokeObjectURL(outputUrl);outputUrl=null;}
  function prepareDownload(bytes){clearOutputUrl();const blob=new Blob([bytes],{type:'application/pdf'});outputUrl=URL.createObjectURL(blob);els.download.disabled=false;els.resultText.textContent=`${selectedFile.name} · ${fmtBytes(blob.size)}`;els.result.classList.remove('hidden');}
  function downloadPrepared(){if(!outputUrl||!selectedFile)return;const a=document.createElement('a');a.href=outputUrl;a.download=selectedFile.name;document.body.appendChild(a);a.click();a.remove();}

  async function pdfJsCrossCheck(bytes) {
    if (window.pdfjsReady) await window.pdfjsReady;
    if (!window.pdfjsLib) return { available:false };
    try {
      const loadingTask = window.pdfjsLib.getDocument({ data: bytes.slice ? bytes.slice(0) : new Uint8Array(bytes) });
      const pdf = await loadingTask.promise;
      let textItems = 0;
      const samplePages = Math.min(pdf.numPages, 3);
      for (let i = 1; i <= samplePages; i += 1) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        textItems += content.items.length;
      }
      return { available:true, pages:pdf.numPages, textItems };
    } catch (error) {
      console.warn('PDF.js cross-check skipped:', error);
      return { available:false, error:String(error?.message || error) };
    }
  }

  async function processFile(file){
    if(!file||busy)return; clearMessages(); clearOutputUrl(); cleanedBytes=null; lastAnalysis=null;
    els.summary.classList.add('hidden');els.brandSummary.classList.add('hidden');els.pageList.classList.add('hidden');els.pageList.innerHTML='';els.preview.classList.add('hidden');els.empty.classList.remove('hidden');
    if(file.type&&file.type!=='application/pdf'&&!file.name.toLowerCase().endsWith('.pdf')){showError('Please select a PDF file.');return;}
    if(file.size>CONFIG.maxFileBytes){showError(`Please use a PDF smaller than ${fmtBytes(CONFIG.maxFileBytes)}. This file is ${fmtBytes(file.size)}.`);return;}
    selectedFile=file;sourceBytes=new Uint8Array(await file.arrayBuffer());els.fileMeta.textContent=`${file.name} · ${fmtBytes(file.size)}`;els.fileMeta.classList.remove('hidden');setBusy(true);setStatus('Analyzing PDF structure…','scanning');els.empty.classList.add('hidden');
    try{
      const analysis=await scanPdf(sourceBytes,false,'Analyzing');
      const pdfJsInfo=await pdfJsCrossCheck(sourceBytes);
      if(pdfJsInfo.available && pdfJsInfo.pages!==analysis.pageCount) throw new Error('PDF.js and the structural parser reported different page counts. Download was blocked.');
      analysis.pdfJsInfo=pdfJsInfo; lastAnalysis=analysis; renderSummary(analysis,sourceBytes); renderPreview(analysis);
      if(!analysis.totalHits){setStatus('No configured watermark found','clean');els.resultText.textContent='No allowlisted watermark signature was detected, so the original PDF remains unchanged.';els.result.classList.remove('hidden');els.download.disabled=true;return;}
      setStatus('Removing matched objects…','scanning');const cleaned=await scanPdf(sourceBytes,true,'Removing watermark from');
      if(cleaned.totalHits!==analysis.totalHits) throw new Error(`The cleanup pass found a different number of eligible objects (${cleaned.totalHits}) than the analysis pass (${analysis.totalHits}). Download was blocked.`);
      setStatus('Verifying document integrity…','scanning');const verification=await scanPdf(cleaned.bytes,false,'Verifying');
      if(verification.totalHits!==0) throw new Error(`Verification found ${verification.totalHits} eligible watermark object(s) still present. Download was blocked.`);
      // Basic integrity checks that do not require rasterization.
      if(verification.pageCount!==analysis.pageCount) throw new Error('Page count changed during cleanup. Download was blocked.');
      cleanedBytes=cleaned.bytes;renderSummary(analysis,cleanedBytes);prepareDownload(cleanedBytes);els.verifyBox.classList.remove('hidden');els.verifyText.textContent='Page count preserved. A second structural scan found 0 remaining allowlisted watermark objects. No page rasterization was used.';setStatus('Verified — ready to download','clean');
    }catch(e){console.error(e);setStatus('Processing failed','idle');showError(normalizeError(e));}
    finally{hideProgress();setBusy(false);}
  }
  function resetAll(){if(busy)return;selectedFile=null;sourceBytes=null;cleanedBytes=null;lastAnalysis=null;els.file.value='';els.fileMeta.textContent='';els.fileMeta.classList.add('hidden');els.summary.classList.add('hidden');els.brandSummary.classList.add('hidden');els.pageList.classList.add('hidden');els.pageList.innerHTML='';els.preview.classList.add('hidden');els.empty.classList.remove('hidden');hideProgress();clearMessages();clearOutputUrl();setStatus('Waiting for PDF','idle');}

  els.file.addEventListener('change',()=>processFile(els.file.files?.[0]));
  els.browse.addEventListener('click',(e)=>{e.preventDefault();if(!busy)els.file.click();});
  els.download.addEventListener('click',downloadPrepared);els.reset.addEventListener('click',resetAll);
  ['dragenter','dragover'].forEach(n=>els.drop.addEventListener(n,e=>{e.preventDefault();if(!busy)els.drop.classList.add('drag');}));
  ['dragleave','drop'].forEach(n=>els.drop.addEventListener(n,e=>{e.preventDefault();els.drop.classList.remove('drag');}));
  els.drop.addEventListener('drop',e=>{if(!busy)processFile(e.dataTransfer?.files?.[0]);});
  resetAll();
})();
