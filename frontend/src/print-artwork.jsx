import './print-artwork.css';

function PaperLines({ receipt = false }) {
  return (
    <span className={receipt ? 'print-art-lines print-art-lines-receipt' : 'print-art-lines'}>
      <i />
      <i />
      <i />
      {receipt && <i />}
    </span>
  );
}

export function PrinterArtwork({ phone = false, compact = false, className = '' }) {
  const classes = [
    'print-artwork',
    phone && 'print-artwork-with-phone',
    compact && 'print-artwork-compact',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={classes} aria-hidden="true">
      <div className="print-art-scene">
        <span className="print-art-ground" />
        <div className="print-art-printer">
          <span className="print-art-feed-shadow" />
          <span className="print-art-feed"><PaperLines /></span>
          <span className="print-art-body-shadow" />
          <span className="print-art-side" />
          <span className="print-art-top" />
          <span className="print-art-feed-slot" />
          <span className="print-art-front">
            <span className="print-art-status" />
            <span className="print-art-output-slot" />
          </span>
          <span className="print-art-output"><PaperLines /></span>
        </div>
        {phone && (
          <div className="print-art-phone">
            <span className="print-art-phone-screen">
              <span className="print-art-phone-speaker" />
              <span className="print-art-phone-file">
                <i /><i /><i />
              </span>
              <span className="print-art-phone-home" />
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function ReceiptArtwork({ className = '' }) {
  return (
    <div className={['receipt-artwork', className].filter(Boolean).join(' ')} aria-hidden="true">
      <span className="receipt-art-ground" />
      <span className="receipt-art-back-roll" />
      <span className="receipt-art-roll-core" />
      <span className="receipt-art-paper">
        <PaperLines receipt />
      </span>
      <span className="receipt-art-front-curl" />
    </div>
  );
}
