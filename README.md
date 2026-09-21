# pi-math-sixel

A Pi extension that renders LaTeX display formulas as transparent Sixel graphics. Works in [Windows Terminal](https://github.com/microsoft/terminal) and other Sixel-capable terminals.

Formulas are typeset with MathJax and rasterized via Resvg, matching the current theme text color.

## Installation

```bash
pi install npm:@maaamahahh/pi-math-sixel
```

or from a local clone:

```bash
pi install ./pi-math-sixel
```

## Configuration

Set `PI_MATH_SIXEL_ALIGN=center` to center formulas (defaults to `left`, matching Pi message padding).

---

<img width="1823" height="1031" alt="image" src="https://github.com/user-attachments/assets/5b03d24c-b8d5-46a6-94b5-cfe83f21aa15" />