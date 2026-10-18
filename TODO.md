# TODO: Salvaging

## Plan for Expanding OCR Use for Salvaging

- [ ] Integrate OCR to detect salvageable items in the game.
- [ ] Implement an overlay to show salvaged items.
- [ ] Allow users to configure a hotkey to dismiss the overlay.
- [ ] Ensure the hotkey is set via the settings page.
- [ ] Test the system across different platforms (desktop, mobile, web).
- [ ] Document the new feature in the README.


#### **2. Review Existing Project Tools and Libraries**
- **OCR and Screen Capture**:
  - Already implemented using **Tesseract.js** (`tesseract.js` and `@tesseract.js-data/eng`).
- **UI Framework**:
  - **React** is already in use for the UI.
- **Electron Integration**:
  - **Electron** supports overlays and hotkeys via **main process** and **renderer process** communication.

#### **3. Define the Scope of the Overlay and Hotkey System**
- **Primary Goals**:
  - Create an **overlay** that appears when the OCR detects a terminal or game UI.
  - The overlay must **show OCR results** (e.g., rock composition, cargo data, and salvageable items).
  - The overlay should be **click-through** by default.
  - A **pre-configured hotkey** (e.g., `Ctrl + Shift + T`) should **dismiss** the overlay.
  - The **hotkey configuration** must be available in a **settings page**.

#### **4. Plan for UI/UX Design**
- **Overlay UI**:
  - A **semi-transparent**, **click-through** overlay showing OCR results.
  - Should **not block user interaction** unless the hotkey is pressed.
- **Settings Page**:
  - A **settings panel** where users can define the **hotkey**.
  - Should persist the **hotkey configuration** (e.g., in `localStorage` or a JSON file).

#### **5. Decide on the Hotkey Format**
- Use a **standard keyboard shortcut** (e.g., `Ctrl + Shift + T`).
- The hotkey must be **configurable** by the user via the **settings page**.

---

### **Phase 1 Summary**
- **Existing Tools and Libraries**: Already available (Electron, React, Tesseract.js, Capacitor).
- **Components to Build**:
  - **Overlay UI** (React) that shows OCR results.
  - **Hotkey Configuration** (Settings page) to define the hotkey.
  - **Hotkey Listener** (Electron) to detect the hotkey and dismiss the overlay.
- **Next Step**: Proceed to **Phase 2** by implementing **screen capture**, **OCR detection**, and **overlay**.
