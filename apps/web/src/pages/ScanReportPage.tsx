interface Props {
  scanId: string;
  onBack: () => void;
}

export const ScanReportPage = ({ scanId, onBack }: Props) => {
  const baseUrl = `/api/v1/scans/${scanId}/report`;

  return (
    <div data-testid="scan-report-page">
      <button type="button" onClick={onBack} data-testid="scan-report-back">
        Back
      </button>
      <h1>Scan Report</h1>

      <div data-testid="report-downloads">
        <a href={`${baseUrl}.html`} target="_blank" rel="noreferrer" data-testid="download-html">
          View HTML
        </a>{' '}
        <a href={`${baseUrl}.json`} download={`report-${scanId}.json`} data-testid="download-json">
          Download JSON
        </a>{' '}
        <a href={`${baseUrl}.zip`} download={`report-${scanId}.zip`} data-testid="download-zip">
          Download ZIP
        </a>{' '}
        <a href={`${baseUrl}.pdf`} download={`report-${scanId}.pdf`} data-testid="download-pdf">
          Download PDF
        </a>
      </div>

      <iframe
        src={`${baseUrl}.html`}
        title="Scan Report"
        data-testid="report-iframe"
        style={{ width: '100%', height: '600px', border: '1px solid #ccc', marginTop: '1rem' }}
      />
    </div>
  );
};
