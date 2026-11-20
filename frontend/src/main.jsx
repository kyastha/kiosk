import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Checkout } from './checkout.jsx';
import { OrderStatus, Payment } from './payment.jsx';
import { Loading, OfflineNotice } from './ui.jsx';
import './styles.css';

const Admin = lazy(() => import('./admin.jsx'));
const Kiosk = lazy(() => import('./kiosk.jsx'));
const PrinterDisplay = lazy(() => import('./printer-display.jsx'));
const Scanner = lazy(() => import('./scanner.jsx'));

function App() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const handleNetwork = () => setOnline(navigator.onLine);
    window.addEventListener('online', handleNetwork);
    window.addEventListener('offline', handleNetwork);
    return () => {
      window.removeEventListener('online', handleNetwork);
      window.removeEventListener('offline', handleNetwork);
    };
  }, []);

  const path = window.location.pathname.split('/').filter(Boolean);
  const kiosk = path[0] === 'kiosk';
  let view = <Checkout online={online} />;
  if (path[0] === 'admin') view = <Admin online={online} />;
  if (kiosk) view = <Kiosk online={online} />;
  if (path[0] === 'printer') view = <PrinterDisplay online={online} />;
  if (path[0] === 'scan') view = <Scanner online={online} />;
  if (['pay', 'payment'].includes(path[0])) view = <Payment reference={path[1] || ''} online={online} />;
  if (['order', 'orders'].includes(path[0])) {
    const key = new URLSearchParams(window.location.search).get('key');
    view = <OrderStatus id={path[1] || ''} accessKey={key} online={online} />;
  }

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {!online && !kiosk && <OfflineNotice />}
      <Suspense fallback={<Loading />}>{view}</Suspense>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
