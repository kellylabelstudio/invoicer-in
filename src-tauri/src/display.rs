#[derive(Debug)]
pub struct WindowFit {
    pub size: (u32, u32),
    pub minimum: (u32, u32),
    pub position: (i32, i32),
}

// Work area excludes the taskbar. All output coordinates are physical pixels.
pub fn fit_window(
    position: (i32, i32),
    work: (u32, u32),
    scale: f64,
    chrome: (u32, u32),
) -> Option<WindowFit> {
    if !scale.is_finite() || scale <= 0.0 || work.0 == 0 || work.1 == 0 {
        return None;
    }
    let pixels = |logical: f64| (logical * scale).round() as u32;
    let margin = pixels(12.0).min(work.0 / 20).min(work.1 / 20);
    let available = (
        work.0.saturating_sub(2 * margin + chrome.0),
        work.1.saturating_sub(2 * margin + chrome.1),
    );
    if available.0 == 0 || available.1 == 0 {
        return None;
    }
    let size = (
        pixels(1280.0).min(available.0),
        pixels(820.0).min(available.1),
    );
    Some(WindowFit {
        size,
        minimum: (pixels(680.0).min(size.0), pixels(510.0).min(size.1)),
        position: (
            position.0 + ((work.0 - size.0 - chrome.0) / 2) as i32,
            position.1 + ((work.1 - size.1 - chrome.1) / 2) as i32,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_small_high_dpi_work_areas_including_title_bar() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let work = (1366, 720);
            let chrome = (16, (39.0 * scale) as u32);
            let fit = fit_window((0, 0), work, scale, chrome).unwrap();
            assert!(fit.size.0 + chrome.0 <= work.0);
            assert!(fit.size.1 + chrome.1 <= work.1);
            assert!(fit.minimum.0 <= fit.size.0 && fit.minimum.1 <= fit.size.1);
            assert!(fit.position.0 >= 0 && fit.position.1 >= 0);
            assert!(fit.position.0 as u32 + fit.size.0 + chrome.0 <= work.0);
            assert!(fit.position.1 as u32 + fit.size.1 + chrome.1 <= work.1);
        }
    }

    #[test]
    fn respects_a_secondary_monitor_and_taskbar_offset() {
        let fit = fit_window((-1920, 48), (1920, 1032), 1.0, (16, 39)).unwrap();
        assert_eq!(fit.size, (1280, 820));
        assert_eq!(fit.position, (-1608, 134));
        assert_eq!(fit.minimum, (680, 510));
    }

    #[test]
    fn does_not_expand_beyond_the_preferred_size_on_a_large_monitor() {
        let fit = fit_window((0, 0), (3840, 2080), 2.0, (32, 78)).unwrap();
        assert_eq!(fit.size, (2560, 1640));
    }

    #[test]
    fn ignores_invalid_or_unavailable_monitor_information() {
        assert!(fit_window((0, 0), (0, 0), 1.0, (16, 39)).is_none());
        assert!(fit_window((0, 0), (800, 600), f64::NAN, (16, 39)).is_none());
        assert!(fit_window((0, 0), (800, 600), 0.0, (16, 39)).is_none());
    }
}
