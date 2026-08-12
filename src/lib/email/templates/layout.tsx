import * as React from 'react'
import { Body, Container, Head, Hr, Html, Preview, Section, Text } from '@react-email/components'

/**
 * Every color and font stack below is a LITERAL value resolved from
 * `design/branding.md`'s Color and Typography tables. Mail clients strip
 * `:root`, so a CSS custom property like `var(--court)` renders as nothing —
 * duplicating each token's value here (once, in this one file, named after
 * its token) is the correct pattern for this slice, not something to "fix"
 * back to a shared CSS variable. Every other template in this directory
 * imports these named constants rather than re-deriving the hex itself, so
 * there is exactly one place a rebrand would need to touch.
 */
export const INK = '#0C1F16' // --ink: primary text, dark surfaces
export const INK_SOFT = '#5B6E60' // --ink-soft: secondary text
export const SURFACE = '#FAFBF8' // --surface: page background
export const PANEL = '#FFFFFF' // --panel: cards, panels
export const HAIRLINE = '#E5EAE2' // --hairline: borders, dividers
export const COURT = '#2E6B4F' // --court: primary green (links, kickers, accents) -- used for the dashboard path call-outs below
export const BALL = '#E8FF54' // --ball: optic lime -- the wordmark's accent square only
export const BAND_OFF = '#EAF2E4' // --band-off: soft green tint for informational blocks

// --display / --body font stacks (Typography table). Google Fonts are not
// loaded in email -- mail clients are unreliable about @import/@font-face --
// so these resolve straight to the stack's own system-font fallbacks.
export const DISPLAY_FONT = '"Inter Tight","Inter","Helvetica Neue",Arial,sans-serif'
export const BODY_FONT = '"Inter","Helvetica Neue",Arial,sans-serif'
export const MONO_FONT = '"Spline Sans Mono","SF Mono",Menlo,monospace'

// Card base recipe's shadow (branding.md "Cards, base recipe" --shadow-sm).
// Most mail clients ignore box-shadow entirely; harmless where it's dropped.
const CARD_SHADOW = '0 1px 2px rgba(12,31,22,.06), 0 4px 16px rgba(12,31,22,.05)'

/**
 * Every greeting in this slice must handle a null name. `profiles.full_name`
 * is nullable, so falling back to a plain "Hi," -- rather than interpolating
 * `null` into the string -- is not optional.
 */
export function greeting(name: string | null): string {
  return name ? `Hi ${name},` : 'Hi,'
}

const textStyle: React.CSSProperties = {
  fontFamily: BODY_FONT,
  fontSize: 15,
  lineHeight: '1.55',
  color: INK,
  margin: '0 0 16px',
}

/** A single labeled fact, e.g. "COURT" / "Court 1". Mono kicker label per branding.md's mono usage for data. */
export function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <Text style={{ ...textStyle, margin: '0 0 10px' }}>
      <span
        style={{
          display: 'block',
          fontFamily: MONO_FONT,
          fontSize: 11,
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          color: INK_SOFT,
        }}
      >
        {label}
      </span>
      <strong style={{ fontFamily: BODY_FONT, fontSize: 15, color: INK }}>{value}</strong>
    </Text>
  )
}

/** The band-off tinted block that groups a template's FactRows. */
export function FactBox({ children }: { children: React.ReactNode }) {
  return (
    <Section
      style={{
        backgroundColor: BAND_OFF,
        borderRadius: 12,
        padding: '16px 18px 6px',
        margin: '0 0 20px',
      }}
    >
      {children}
    </Section>
  )
}

export function BodyText({ children }: { children: React.ReactNode }) {
  return <Text style={textStyle}>{children}</Text>
}

/**
 * An in-app path called out inside a body sentence (e.g. "/dashboard/bookings").
 * Not a real hyperlink -- these emails don't have a base URL to build one from,
 * and adding that dependency is out of this task's scope -- but styled in
 * `--court`, branding.md's designated color for "links, kickers, accents",
 * so it still reads as the actionable part of the sentence.
 */
export function PathCallout({ children }: { children: React.ReactNode }) {
  return (
    <strong style={{ fontFamily: BODY_FONT, color: COURT, fontWeight: 600 }}>{children}</strong>
  )
}

/**
 * Wraps every email: the oncourt wordmark, a white content card on the app's
 * surface color, and a footer line.
 *
 * `preview` is the inbox preview line and is required, not optional -- an
 * email whose preview text is the first line of boilerplate wastes the only
 * thing a reader sees before opening.
 */
export function EmailLayout({ preview, children }: { preview: string; children: React.ReactNode }) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: SURFACE, margin: 0, padding: '32px 16px', fontFamily: BODY_FONT }}>
        <Container style={{ maxWidth: 480, margin: '0 auto', width: '100%' }}>
          <Section style={{ textAlign: 'center', margin: '0 0 24px' }}>
            <Text
              style={{
                display: 'inline-block',
                fontFamily: DISPLAY_FONT,
                fontWeight: 800,
                fontSize: 20,
                color: INK,
                letterSpacing: '-0.02em',
                margin: 0,
              }}
            >
              oncourt{' '}
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  backgroundColor: BALL,
                  border: `1.5px solid ${INK}`,
                }}
              />
            </Text>
          </Section>
          <Section
            style={{
              backgroundColor: PANEL,
              borderRadius: 20,
              padding: '32px 28px',
              boxShadow: CARD_SHADOW,
            }}
          >
            {children}
          </Section>
          <Hr style={{ borderColor: HAIRLINE, margin: '24px 0 16px', borderWidth: '1px 0 0' }} />
          <Text
            style={{
              fontFamily: BODY_FONT,
              fontSize: 12,
              color: INK_SOFT,
              textAlign: 'center',
              margin: 0,
            }}
          >
            oncourt · This is an automated message, please do not reply.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}
