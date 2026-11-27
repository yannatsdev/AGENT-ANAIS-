import { jsPDF } from 'jspdf';
import { InterviewRecord } from '../types/interview';
import {
  buildPdfFilename,
  formatDuration,
  sanitizePdfText,
} from './interviewLogic';

/**
 * Generates and downloads a branded L'Agence X diagnostic PDF report for an interview.
 * Runs 100% client-side so it works seamlessly both online and in Offline Mode.
 */
export function exportInterviewToPdf(record: InterviewRecord): string {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 18;
  const contentWidth = pageWidth - margin * 2;
  let y = 0;

  const clean = (v?: string) => sanitizePdfText(v || '');

  const ensureSpace = (neededMm: number) => {
    if (y + neededMm > pageHeight - 18) {
      doc.addPage();
      y = 20;
    }
  };

  // Header Banner — Obsidian dark with Gold accent rule
  doc.setFillColor(10, 10, 12);
  doc.rect(0, 0, pageWidth, 38, 'F');
  doc.setFillColor(196, 154, 69);
  doc.rect(0, 38, pageWidth, 1.2, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.text(clean("L'AGENCE X  ·  ANAÏS"), margin, 16);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(196, 154, 69);
  doc.text(
    clean("ÉTUDE PME CÔTE D'IVOIRE - SYNTHÈSE AUTOMATIQUE DES POINTS BLOQUANTS"),
    margin,
    24
  );

  doc.setTextColor(180, 180, 188);
  doc.setFontSize(8.5);
  const roleLabel =
    record.profile === 'marketing'
      ? 'Directeur·rice Marketing'
      : 'Directeur·rice Général·e';
  const formattedDate = new Date(record.createdAt).toLocaleString('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
  });
  doc.text(
    clean(
      `Profil : ${roleLabel}   |   Durée : ${formatDuration(record.durationSeconds)}   |   Date : ${formattedDate}`
    ),
    margin,
    32
  );

  y = 48;

  // Participant & Company Card (dynamic height prevents overflow on long fields)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  const companyLines = doc.splitTextToSize(
    clean(record.companyName || 'Entreprise confidentielle'),
    contentWidth - 10
  );
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  const participantLines = doc.splitTextToSize(
    clean(
      `Interlocuteur : ${record.participantName || 'Anonyme'}${record.contactInfo ? `  ·  Contact : ${record.contactInfo}` : ''}`
    ),
    contentWidth - 10
  );
  doc.setFontSize(8.5);
  const metricsLines = doc.splitTextToSize(
    clean(
      `Temps perdu estimé : ${record.summary.timeLostEstimate}  ·  Niveau : ${record.summary.maturityLevel}`
    ),
    contentWidth - 10
  );

  const cardHeight =
    8 +
    companyLines.length * 5.2 +
    participantLines.length * 4.6 +
    metricsLines.length * 4.4 +
    4;

  doc.setFillColor(246, 246, 248);
  doc.setDrawColor(225, 225, 230);
  doc.roundedRect(margin, y, contentWidth, cardHeight, 2, 2, 'FD');

  let cardY = y + 7;
  doc.setTextColor(18, 18, 22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(companyLines, margin + 5, cardY);
  cardY += companyLines.length * 5.2 + 1;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(75, 75, 85);
  doc.text(participantLines, margin + 5, cardY);
  cardY += participantLines.length * 4.6 + 1;

  doc.setFontSize(8.5);
  doc.text(metricsLines, margin + 5, cardY);

  y += cardHeight + 8;

  // Section 1: Executive Summary
  doc.setTextColor(10, 10, 12);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  const headlineLines = doc.splitTextToSize(
    clean(record.summary.headline),
    contentWidth
  );
  ensureSpace(headlineLines.length * 6 + 10);
  doc.text(headlineLines, margin, y);
  y += headlineLines.length * 6 + 3;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(50, 50, 60);
  const execLines = doc.splitTextToSize(
    clean(record.summary.executiveSummary),
    contentWidth
  );
  ensureSpace(execLines.length * 5 + 8);
  doc.text(execLines, margin, y);
  y += execLines.length * 5 + 8;

  // Section 2: Key Pain Points
  ensureSpace(25);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(10, 10, 12);
  doc.text('1. POINTS BLOQUANTS IDENTIFIÉS', margin, y);
  doc.setDrawColor(196, 154, 69);
  doc.setLineWidth(0.5);
  doc.line(margin, y + 2, margin + 62, y + 2);
  y += 9;

  for (const pp of record.summary.keyPainPoints) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    const titleLines = doc.splitTextToSize(
      clean(`${pp.title}  [${pp.severity.toUpperCase()} · ${pp.category}]`),
      contentWidth - 8
    );

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.2);
    const impactLines = doc.splitTextToSize(
      clean(`Impact : ${pp.impact}`),
      contentWidth - 8
    );
    const actionLines = doc.splitTextToSize(
      clean(`Recommandation : ${pp.recommendedAction}`),
      contentWidth - 8
    );

    const blockHeight =
      7 +
      titleLines.length * 5 +
      impactLines.length * 4.6 +
      actionLines.length * 4.6 +
      4;
    ensureSpace(blockHeight + 4);

    doc.setFillColor(250, 250, 252);
    doc.setDrawColor(230, 230, 236);
    doc.roundedRect(margin, y, contentWidth, blockHeight, 1.5, 1.5, 'FD');

    let itemY = y + 6.5;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(15, 15, 20);
    doc.text(titleLines, margin + 4, itemY);
    itemY += titleLines.length * 5 + 1;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.2);
    doc.setTextColor(60, 60, 70);
    doc.text(impactLines, margin + 4, itemY);
    itemY += impactLines.length * 4.6 + 1;

    doc.setTextColor(20, 95, 78);
    doc.text(actionLines, margin + 4, itemY);

    y += blockHeight + 4;
  }

  // Section 3: Agency X Recommended Offers
  if (record.summary.recommendedOffers.length > 0) {
    ensureSpace(25);
    y += 3;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(10, 10, 12);
    doc.text("2. PISTES D'ACCOMPAGNEMENT L'AGENCE X", margin, y);
    doc.setDrawColor(196, 154, 69);
    doc.line(margin, y + 2, margin + 78, y + 2);
    y += 9;

    for (const rec of record.summary.recommendedOffers) {
      const rationaleLines = doc.splitTextToSize(
        clean(rec.rationale),
        contentWidth - 6
      );
      ensureSpace(10 + rationaleLines.length * 4.8);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.8);
      doc.setTextColor(18, 18, 22);
      doc.text(clean(`- ${rec.offer} (${rec.relevance})`), margin, y);
      y += 5;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.2);
      doc.setTextColor(65, 65, 75);
      doc.text(rationaleLines, margin + 4, y);
      y += rationaleLines.length * 4.6 + 3.5;
    }
  }

  // Section 4: Structured Questionnaire Answers (wrapped 2-column layout prevents overlap)
  if (record.summary.structuredAnswers.length > 0) {
    ensureSpace(24);
    y += 3;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(10, 10, 12);
    doc.text('3. RÉPONSES STRUCTURÉES DU QUESTIONNAIRE', margin, y);
    doc.setDrawColor(196, 154, 69);
    doc.line(margin, y + 2, margin + 84, y + 2);
    y += 9;

    const labelColWidth = 54;
    const valueColX = margin + labelColWidth + 4;
    const valueColWidth = contentWidth - labelColWidth - 4;

    for (const ans of record.summary.structuredAnswers) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.8);
      const labelLines = doc.splitTextToSize(
        clean(`${ans.questionId} · ${ans.label}`),
        labelColWidth
      );
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      const valLines = doc.splitTextToSize(clean(ans.value), valueColWidth);

      const rowHeight = Math.max(labelLines.length, valLines.length) * 4.5 + 2.5;
      ensureSpace(rowHeight);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.8);
      doc.setTextColor(30, 30, 38);
      doc.text(labelLines, margin, y);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(65, 65, 75);
      doc.text(valLines, valueColX, y);

      y += rowHeight;
    }
  }

  // Section 5: Decision Factors & Next Steps
  ensureSpace(24);
  y += 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(10, 10, 12);
  doc.text('4. LEVIERS DE DÉCISION & PROCHAINES ÉTAPES', margin, y);
  doc.setDrawColor(196, 154, 69);
  doc.line(margin, y + 2, margin + 88, y + 2);
  y += 9;

  if (record.summary.decisionFactors && record.summary.decisionFactors.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.2);
    doc.setTextColor(30, 30, 38);
    doc.text('Facteurs de décision identifiés :', margin, y);
    y += 5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.2);
    doc.setTextColor(60, 60, 70);
    for (const factor of record.summary.decisionFactors) {
      const factorLines = doc.splitTextToSize(clean(`- ${factor}`), contentWidth - 4);
      ensureSpace(factorLines.length * 4.5 + 2);
      doc.text(factorLines, margin + 2, y);
      y += factorLines.length * 4.5 + 1.5;
    }
    y += 3;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(50, 50, 60);
  const nextLines = doc.splitTextToSize(
    clean(record.summary.nextSteps),
    contentWidth
  );
  ensureSpace(nextLines.length * 4.8 + 8);
  doc.text(nextLines, margin, y);
  y += nextLines.length * 4.8 + 8;

  // Section 6: Transcript excerpt
  if (record.transcript.length > 0) {
    ensureSpace(24);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(10, 10, 12);
    doc.text("5. TRANSCRIPTION DE L'ÉCHANGE", margin, y);
    doc.setDrawColor(196, 154, 69);
    doc.line(margin, y + 2, margin + 62, y + 2);
    y += 9;

    for (const line of record.transcript) {
      const speakerLabel =
        line.speaker === 'anais'
          ? 'Anaïs'
          : record.participantName || 'Participant';
      const wrapped = doc.splitTextToSize(
        clean(`[${line.timestamp}] ${speakerLabel} : ${line.text}`),
        contentWidth
      );
      ensureSpace(wrapped.length * 4.4 + 2.5);
      doc.setFont('helvetica', line.speaker === 'anais' ? 'bold' : 'normal');
      doc.setFontSize(8.8);
      doc.setTextColor(
        line.speaker === 'anais' ? 20 : 60,
        line.speaker === 'anais' ? 20 : 60,
        line.speaker === 'anais' ? 28 : 70
      );
      doc.text(wrapped, margin, y);
      y += wrapped.length * 4.3 + 2;
    }
  }

  // Footer on every page
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 150);
    doc.text(
      clean("L'Agence X - Étude PME Côte d'Ivoire (Anaïs)  ·  Confidentiel"),
      margin,
      pageHeight - 10
    );
    doc.text(`Page ${p} / ${pageCount}`, pageWidth - margin - 18, pageHeight - 10);
  }

  const filename = buildPdfFilename(record);
  doc.save(filename);
  return filename;
}
