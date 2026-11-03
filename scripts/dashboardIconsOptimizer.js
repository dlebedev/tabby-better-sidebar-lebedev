const { optimize } = require('svgo')

/** Compact only numeric values and drawing commands, preserving icon IDs, CSS,
 * colours and structure. */
const SVG_OPTIMIZER_PLUGINS = [
    'cleanupAttrs',
    { name: 'cleanupNumericValues', params: { floatPrecision: 3 } },
    { name: 'convertPathData', params: { floatPrecision: 3, transformPrecision: 5 } },
    { name: 'convertTransform', params: { floatPrecision: 5 } },
    'removeEmptyAttrs',
    'sortAttrs',
]

/** Reduce the stored size of offline service icons with safe numeric normalisation. */
function optimizeDashboardSvg (svg) {
    return optimize(svg, { plugins: SVG_OPTIMIZER_PLUGINS }).data
}

/** Optimise grouped icons in bulk; unparsable originals are kept and recorded
 * rather than breaking the build. */
function optimizeDashboardIcons (data) {
    let optimizedSvgCount = 0
    let optimizedBytesSaved = 0
    const skipped = []

    for (const [name, entry] of Object.entries(data)) {
        for (const [variant, svg] of Object.entries(entry.variants)) {
            try {
                const optimized = optimizeDashboardSvg(svg)
                entry.variants[variant] = optimized
                optimizedSvgCount++
                optimizedBytesSaved += Buffer.byteLength(svg, 'utf8') - Buffer.byteLength(optimized, 'utf8')
            } catch {
                skipped.push(`${name}:${variant}`)
            }
        }
    }

    return { optimizedSvgCount, optimizedBytesSaved, skipped }
}

module.exports = { optimizeDashboardSvg, optimizeDashboardIcons }
