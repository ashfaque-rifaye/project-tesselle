import { Route, Routes } from "react-router-dom";
import Hub from "./pages/Hub";
import Workspace from "./pages/Workspace";
import Phone from "./pages/Phone";
import Seller from "./pages/Seller";
import Glasses from "./pages/Glasses";
import Share from "./pages/Share";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Hub />} />
      <Route path="/p/:pid" element={<Workspace />} />
      <Route path="/p/:pid/:stage" element={<Workspace />} />
      <Route path="/m/:pid" element={<Phone />} />
      <Route path="/g/:pid" element={<Glasses />} />
      <Route path="/share" element={<Share />} />
      <Route path="/seller" element={<Seller />} />
      <Route path="/seller/:sellerId" element={<Seller />} />
      <Route path="*" element={<Hub />} />
    </Routes>
  );
}
