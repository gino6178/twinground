// Project page behaviour, adapted from the Academic Project Page Template's index.js without jQuery.

function toggleMoreWorks() {
  const dropdown = document.getElementById('moreWorksDropdown')
  const button = document.querySelector('.more-works-btn')
  const open = !dropdown.classList.contains('show')
  dropdown.classList.toggle('show', open)
  button.classList.toggle('active', open)
  button.setAttribute('aria-expanded', String(open))
}

function closeMoreWorks() {
  const dropdown = document.getElementById('moreWorksDropdown')
  const button = document.querySelector('.more-works-btn')
  if (!dropdown || !button) return
  dropdown.classList.remove('show')
  button.classList.remove('active')
  button.setAttribute('aria-expanded', 'false')
}

document.addEventListener('click', event => {
  const container = document.querySelector('.more-works-container')
  if (container && !container.contains(event.target)) closeMoreWorks()
})
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMoreWorks() })

function copyBibTeX() {
  const code = document.getElementById('bibtex-code')
  const button = document.querySelector('.copy-bibtex-btn')
  const label = button.querySelector('.copy-text')
  const done = () => {
    button.classList.add('copied')
    label.textContent = button.dataset.copied || 'Copied'
    setTimeout(() => { button.classList.remove('copied'); label.textContent = button.dataset.copy || 'Copy' }, 2000)
  }
  navigator.clipboard.writeText(code.textContent).then(done).catch(() => {
    const area = document.createElement('textarea')
    area.value = code.textContent
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
    done()
  })
}

function scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }) }

window.addEventListener('scroll', () => {
  document.querySelector('.scroll-to-top')?.classList.toggle('visible', window.pageYOffset > 300)
}, { passive: true })

document.addEventListener('DOMContentLoaded', () => {
  if (window.bulmaCarousel) {
    window.bulmaCarousel.attach('.carousel', { slidesToScroll: 1, slidesToShow: 1, loop: true, infinite: true, autoplay: true, autoplaySpeed: 6000, pauseOnHover: true })
  }
})
