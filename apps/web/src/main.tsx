import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';import {DesignPreview} from './components/DesignPreview';import './styles/global.css';
createRoot(document.getElementById('root')!).render(<BrowserRouter><DesignPreview/></BrowserRouter>);
