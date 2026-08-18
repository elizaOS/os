// Renders the branded, guided entry point for every elizaOS install path.
import { useMemo, useState } from "react";
import { HttpAospFlasherBackend } from "../backend/http-backend";
import { FlasherApp } from "./FlasherApp";
import { IosFlasher } from "./IosFlasher";

type TabId = "usb" | "android" | "ios";

interface Tab {
  id: TabId;
  shortLabel: string;
  title: string;
  description: string;
}

const TABS: Tab[] = [
  {
    id: "usb",
    shortLabel: "USB",
    title: "Computer",
    description: "Make a bootable USB for a desktop or laptop.",
  },
  {
    id: "android",
    shortLabel: "A",
    title: "Android phone",
    description: "Install elizaOS on a supported Pixel.",
  },
  {
    id: "ios",
    shortLabel: "iOS",
    title: "iPhone or iPad",
    description: "Install the Eliza app on an Apple device.",
  },
];

const USB_INSTALLER_DEV_URL = "http://127.0.0.1:3742";
const USB_INSTALLER_DOWNLOAD_URL = "https://elizaos.ai/downloads#usb-installer";

interface OpenItemShell {
  openExternal?: (url: string) => unknown;
  openItem?: (path: string) => unknown;
}

interface ElectrobunWindowGlobal {
  electrobun?: { shell?: OpenItemShell };
}

function openExternal(url: string): void {
  const w = window as ElectrobunWindowGlobal;
  const shell = w.electrobun?.shell;
  if (shell?.openExternal) {
    shell.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function tryLaunchPackagedUsbInstaller(): boolean {
  const w = window as ElectrobunWindowGlobal;
  const shell = w.electrobun?.shell;
  if (!shell?.openItem) return false;
  try {
    shell.openItem("/Applications/elizaOS USB Installer.app");
    return true;
  } catch {
    return false;
  }
}

function isDev(): boolean {
  try {
    const meta = import.meta as { env?: { DEV?: boolean } };
    return meta.env?.DEV === true;
  } catch {
    return false;
  }
}

function handleOpenUsbInstaller(): void {
  if (isDev()) {
    openExternal(USB_INSTALLER_DEV_URL);
    return;
  }
  if (tryLaunchPackagedUsbInstaller()) return;
  openExternal(USB_INSTALLER_DOWNLOAD_URL);
}

function UsbInstallerPanel() {
  return (
    <div className="install-panel-content usb-panel">
      <div className="install-panel-copy">
        <span className="section-kicker">For a desktop or laptop</span>
        <h2>Make a bootable elizaOS USB</h2>
        <p className="panel-lede">
          The USB Installer downloads the right image, checks it, and walks you
          through choosing a drive.
        </p>
        <div className="friendly-note" role="note">
          <span className="friendly-note-icon" aria-hidden>
            ✓
          </span>
          <div>
            <strong>You stay in control.</strong>
            <span>
              Nothing is erased until you review the exact drive and confirm.
            </span>
          </div>
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="brand-button"
            onClick={handleOpenUsbInstaller}
          >
            Open USB Installer
            <span aria-hidden>→</span>
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => openExternal(USB_INSTALLER_DOWNLOAD_URL)}
          >
            Download it instead
          </button>
        </div>
      </div>

      <ol className="how-it-works" aria-label="How USB setup works">
        <li>
          <span>1</span>
          <div>
            <strong>Connect a spare USB drive</strong>
            <p>16 GB or larger is a comfortable choice.</p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>Choose your computer</strong>
            <p>We’ll select the compatible elizaOS image.</p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Review, then create</strong>
            <p>You’ll see the drive name and size before anything changes.</p>
          </div>
        </li>
      </ol>
    </div>
  );
}

export interface InstallerShellProps {
  serverUrl: string;
}

export function InstallerShell({ serverUrl }: InstallerShellProps) {
  const [activeTab, setActiveTab] = useState<TabId>("usb");
  const backend = useMemo(
    () => new HttpAospFlasherBackend(`${serverUrl}/api`),
    [serverUrl],
  );

  return (
    <div className="installer-shell">
      <header className="installer-hero">
        <div className="installer-header-row">
          <div className="installer-brand">
            <img
              className="installer-logo"
              src="./brand/logos/elizaos_logotext.svg"
              alt="elizaOS"
            />
            <span className="setup-badge">Setup</span>
          </div>
          <span className="guided-status">
            <span aria-hidden />
            Safe, guided setup
          </span>
        </div>
        <div className="installer-intro">
          <span className="hero-kicker">Let’s get you set up</span>
          <h1>Where do you want to use elizaOS?</h1>
          <p>
            Pick a device. We’ll check what you need and guide you through the
            rest in plain English.
          </p>
        </div>
      </header>

      <main className="installer-main">
        <nav className="install-choice-grid" aria-label="Choose a device">
          {TABS.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                className={`install-choice${isActive ? " active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
                aria-pressed={isActive}
              >
                <span className="choice-icon" aria-hidden>
                  {tab.shortLabel}
                </span>
                <span className="choice-copy">
                  <strong>{tab.title}</strong>
                  <span>{tab.description}</span>
                </span>
                <span className="choice-check" aria-hidden>
                  {isActive ? "✓" : "→"}
                </span>
              </button>
            );
          })}
        </nav>

        <section className={`installer-workspace workspace-${activeTab}`}>
          {activeTab === "usb" && <UsbInstallerPanel />}
          {activeTab === "android" && <FlasherApp backend={backend} embedded />}
          {activeTab === "ios" && <IosFlasher serverUrl={serverUrl} />}
        </section>

        <footer className="installer-footer">
          <span>Need help? You can stop at any time.</span>
          <button
            type="button"
            className="footer-link"
            onClick={() => openExternal("https://docs.elizaos.ai")}
          >
            View setup help
          </button>
        </footer>
      </main>
    </div>
  );
}
