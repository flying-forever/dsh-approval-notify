param(
  [string]$TitleText = 'DSH approval request',
  [string]$BodyText = 'A tool is waiting for your decision',
  [string]$HintText = 'Open DeepSeek Harness to answer',
  # Kept as a string on purpose: a caller without a card slot may pass "NaN".
  [string]$Offset = '0',
  [int]$Seconds = 600,
  # Sound only, no card (toggled from the Host settings page).
  [switch]$NoCard,
  # Card only, no sound.
  [switch]$NoSound
)

# Defensive parse: a non-numeric offset (e.g. "NaN" from a test call that has no
# card slot) must not fail parameter binding and silently kill the card.
[int]$offsetPx = 0
if (-not [int]::TryParse($Offset, [ref]$offsetPx)) { $offsetPx = 0 }

# Passive always-on-top reminder card in the TOP-right corner.
#
# Mouse behavior is per-region, not whole-window:
#   - the close button (top-right of the card) hit-tests as HTCLIENT, so a click
#     closes the card;
#   - every other pixel hit-tests as HTTRANSPARENT, so clicks reach the window
#     underneath, including the approval panel that takes over the composer.
# The form draws itself (no child controls): child windows would swallow the
# mouse events that must pass through.
#
# The card still closes by itself when the Host kills the process after the
# approval is answered, or after $Seconds.

# Sound-only mode: no window at all. Play, wait for the async sound to finish
# (process exit truncates it), then quit. Loads only the assembly it needs.
if ($NoCard) {
  if (-not $NoSound) {
    Add-Type -AssemblyName System.Windows.Forms
    try { [System.Media.SystemSounds]::Asterisk.Play() } catch {}
    Start-Sleep -Milliseconds 1500
  }
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Some host windows are topmost themselves; re-assert our z-order once shown
# (no activation, no focus steal).
Add-Type -Namespace NotifyWin -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
'@

$formType = @'
using System;
using System.Drawing;
using System.Drawing.Text;
using System.Windows.Forms;

public class DshApprovalCard : Form {
  public string TitleText = "";
  public string BodyText = "";
  public string HintText = "";

  private readonly Rectangle closeRect;
  private bool hoverClose;

  public DshApprovalCard() {
    FormBorderStyle = FormBorderStyle.None;
    StartPosition = FormStartPosition.Manual;
    ShowInTaskbar = false;
    TopMost = true;
    DoubleBuffered = true;
    Width = 340;
    Height = 104;
    BackColor = Color.FromArgb(32, 34, 40);
    closeRect = new Rectangle(Width - 28, 6, 22, 22);
  }

  protected override bool ShowWithoutActivation { get { return true; } }

  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE: never steal focus
      cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW: stay out of Alt+Tab
      return cp;
    }
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0084) { // WM_NCHITTEST
      long lp = m.LParam.ToInt64();
      int x = unchecked((short)(lp & 0xFFFF));
      int y = unchecked((short)((lp >> 16) & 0xFFFF));
      Point p = PointToClient(new Point(x, y));
      m.Result = new IntPtr(closeRect.Contains(p) ? 1 : -1); // HTCLIENT : HTTRANSPARENT
      return;
    }
    base.WndProc(ref m);
  }

  protected override void OnPaint(PaintEventArgs e) {
    Graphics g = e.Graphics;
    g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

    using (SolidBrush bg = new SolidBrush(BackColor)) {
      g.FillRectangle(bg, ClientRectangle);
    }
    using (SolidBrush accent = new SolidBrush(Color.FromArgb(255, 186, 66))) {
      g.FillRectangle(accent, 0, 0, 4, Height);
    }

    using (Font titleFont = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold)) {
      g.DrawString(TitleText, titleFont, Brushes.White, 18, 8);
    }

    using (Font bodyFont = new Font("Microsoft YaHei UI", 9f))
    using (SolidBrush bodyBrush = new SolidBrush(Color.FromArgb(188, 192, 202)))
    using (StringFormat sf = new StringFormat()) {
      sf.Trimming = StringTrimming.EllipsisCharacter;
      g.DrawString(BodyText, bodyFont, bodyBrush, new RectangleF(18, 38, Width - 46, 42), sf);
    }

    using (Font hintFont = new Font("Microsoft YaHei UI", 8f))
    using (SolidBrush hintBrush = new SolidBrush(Color.FromArgb(255, 186, 66))) {
      g.DrawString(HintText, hintFont, hintBrush, 18, 82);
    }

    // Close affordance: grey, amber while hovered.
    using (Font closeFont = new Font("Segoe UI", 10f))
    using (SolidBrush closeBrush = new SolidBrush(hoverClose ? Color.FromArgb(255, 186, 66) : Color.FromArgb(126, 130, 140))) {
      SizeF size = g.MeasureString("x", closeFont);
      g.DrawString("x", closeFont, closeBrush,
        closeRect.X + (closeRect.Width - size.Width) / 2,
        closeRect.Y + (closeRect.Height - size.Height) / 2);
    }
  }

  protected override void OnMouseMove(MouseEventArgs e) {
    bool hover = closeRect.Contains(e.Location);
    if (hover != hoverClose) {
      hoverClose = hover;
      Invalidate(closeRect);
    }
    base.OnMouseMove(e);
  }

  protected override void OnMouseLeave(EventArgs e) {
    if (hoverClose) {
      hoverClose = false;
      Invalidate(closeRect);
    }
    base.OnMouseLeave(e);
  }

  protected override void OnMouseClick(MouseEventArgs e) {
    if (closeRect.Contains(e.Location)) {
      Close();
      return;
    }
    base.OnMouseClick(e);
  }
}
'@
if (-not ('DshApprovalCard' -as [type])) {
  Add-Type -TypeDefinition $formType -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' | Out-Null
}

$form = New-Object DshApprovalCard
$form.TitleText = $TitleText
$form.BodyText = $BodyText
$form.HintText = $HintText

# Top-right of the working area; cards stack DOWNWARD so they never creep back
# into the composer zone at the bottom.
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $area.Right - $form.Width - 16
$form.Top = $area.Top + 16 + $offsetPx

if ($Seconds -gt 0) {
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = $Seconds * 1000
  $timer.Add_Tick({ $timer.Stop(); $form.Close() })
  $timer.Start()
}

$form.Add_Shown({
  try { if (-not $NoSound) { [System.Media.SystemSounds]::Asterisk.Play() } } catch {}
  try { [void][NotifyWin.Native]::SetWindowPos($form.Handle, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0003) } catch {}
})

[void]$form.ShowDialog()
