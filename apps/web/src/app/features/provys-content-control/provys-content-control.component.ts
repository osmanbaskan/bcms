import { Component } from '@angular/core';

@Component({
  selector: 'app-provys-content-control',
  standalone: true,
  template: `
    <section class="page">
      <h1>Provys İçerik Kontrol</h1>
    </section>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; gap: 16px; }
    h1 { margin: 0; font-size: 28px; font-weight: 600; }
  `],
})
export class ProvysContentControlComponent {}
