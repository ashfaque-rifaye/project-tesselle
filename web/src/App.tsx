import { Route, Routes } from "react-router-dom";
import Hub from "./pages/Hub";
import Workspace from "./pages/Workspace";
import Phone from "./pages/Phone";
import Glasses from "./pages/Glasses";
import Share from "./pages/Share";
import Orders from "./pages/Orders";
import Capture from "./pages/Capture";

/** The misty light every glass surface is seen against. */
function Atmosphere() {
  return (
    <div className="atmos" aria-hidden="true">
      <div className="photo" />
      <i />
      <i />
      <i />
    </div>
  );
}

export default function App() {
  return (
    <>
      <Atmosphere />
      <Routes>
        <Route path="/" element={<Hub />} />
        <Route path="/p/:pid" element={<Workspace />} />
        <Route path="/p/:pid/:stage" element={<Workspace />} />
        <Route path="/m/:pid" element={<Phone />} />
        <Route path="/g/:pid" element={<Glasses />} />
        <Route path="/share" element={<Share />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/c/:pid" element={<Capture />} />
        <Route path="*" element={<Hub />} />
      </Routes>
    </>
  );
}
