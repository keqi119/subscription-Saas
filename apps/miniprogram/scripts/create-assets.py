"""Rebuild original local schematic assets. Requires Pillow only for regeneration."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

DEST = Path(__file__).resolve().parents[1] / 'src' / 'assets'
DEST.mkdir(parents=True, exist_ok=True)
S = 2

def illustration(kind, body):
    im = Image.new('RGBA', (1000*S, 560*S), '#eeeee6')
    d = ImageDraw.Draw(im)
    def polygon(points, fill, outline=None, width=1):
        d.polygon([(int(x*S), int(y*S)) for x,y in points], fill=fill)
        if outline:
            d.line([(int(x*S), int(y*S)) for x,y in points + [points[0]]], fill=outline, width=width*S, joint='curve')
    def ellipse(box, fill, outline=None, width=1):
        d.ellipse(tuple(int(v*S) for v in box), fill=fill, outline=outline, width=width*S)
    def line(points, fill, width=1):
        d.line([(int(x*S), int(y*S)) for x,y in points], fill=fill, width=width*S)
    # Restrained studio background and a ground contact shadow.
    line([(60, 430), (940, 430)], '#d5d8cc')
    shadow = Image.new('RGBA', im.size)
    ImageDraw.Draw(shadow).ellipse((145*S, 395*S, 904*S, 447*S), fill=(44,49,43,55))
    im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(15*S)))
    d = ImageDraw.Draw(im)
    suv = kind == 'suv'
    compact = kind == 'compact'
    roof = 181 if suv else (207 if compact else 214)
    rear = 157 if not compact else 222
    front = 875 if not compact else 837
    points = [(rear, 301), (rear+48, 280), (320, roof+26), (363, roof), (607, roof), (660, roof+18), (740, 287), (front-30, 314), (front,338), (front+5,392), (front-35,414), (rear+2,414), (rear-19,389), (rear-15,329)]
    polygon(points, body, '#4d5851', 2)
    polygon([(rear-12,356), (front,355), (front+4,392), (front-36,414), (rear+4,414), (rear-18,389)], '#718077')
    polygon([(rear+48,292), (330,roof+36), (367,roof+13), (595,roof+13), (638,roof+29), (711,291)], '#34433f', '#52645b', 2)
    polygon([(337,roof+41), (369,roof+20), (470,roof+20), (475,287), (265 if not compact else 283,290)], '#566c64')
    polygon([(490,roof+20), (591,roof+20), (630,roof+34), (690,289), (493,287)], '#4b6058')
    polygon([(374,roof+21), (464,roof+21), (468,245), (340,267)], '#75867c')
    polygon([(500,roof+20), (588,roof+20), (625,roof+34), (655,260), (500,250)], '#697f73')
    line([(241 if not compact else 283,302), (722,302)], '#d9dfd3', 3)
    line([(480,roof+12), (489,393)], '#4c5d54', 2)
    line([(699,300), (725,395)], '#4c5d54', 2)
    line([(308,303), (289,393)], '#4c5d54', 2)
    line([(rear+3,352), (front-13,347)], '#b8c4b9', 2)
    line([(rear+18,395), (front-38,395)], '#becbc0', 3)
    for x in ([314,745] if not compact else [336,719]):
        ellipse((x-60,354,x+60,474), '#3c4741')
        ellipse((x-51,365,x+51,467), '#232b27')
        ellipse((x-34,382,x+34,450), '#c1c7bd')
        ellipse((x-25,391,x+25,441), '#6e7b72')
        ellipse((x-11,405,x+11,427), '#c4cbbf')
        for dx,dy in [(-24,0),(24,0),(0,-24),(0,24)]:
            line([(x,416),(x+dx,416+dy)], '#c8cfc4', 4)
    line([(rear+6,325), (rear+39,320)], '#b44919', 7)
    polygon([(front-84,323), (front-16,338), (front-5,350), (front-79,336)], '#edece0')
    line([(front-39,364), (front-5,367)], '#3d4841', 4)
    line([(435,316), (457,316)], '#d7ddd1', 4)
    line([(645,315), (668,315)], '#d7ddd1', 4)
    polygon([(666,283), (690,281), (706,294), (672,296)], '#4c5b53')
    im.convert('RGB').resize((1000,560), Image.Resampling.LANCZOS).save(DEST / f'car-{kind}.png', optimize=True)

for kind, body in [('sedan','#a9b6aa'), ('suv','#b8b7aa'), ('compact','#c4c8bb')]:
    illustration(kind, body)

# Placeholder deliberately depicts no particular vehicle facts.
im = Image.new('RGB', (1000,560), '#ecece4')
d=ImageDraw.Draw(im)
d.rounded_rectangle((290,200,710,360), radius=14, outline='#a2aa9b', width=3)
d.line([(345,200),(402,150),(579,150),(642,200)], fill='#a2aa9b', width=3)
d.ellipse((332,337,383,388), fill='#b5bcae'); d.ellipse((616,337,667,388), fill='#b5bcae')
im.save(DEST/'car-placeholder.png', optimize=True)

for name in ['home','car','key','person']:
    for active in [False,True]:
        im=Image.new('RGBA',(192,192)); d=ImageDraw.Draw(im)
        color='#252723' if active else '#82877e'; width=9
        if name=='home':
            d.line([(28,88),(96,29),(164,88)],fill=color,width=width,joint='curve')
            d.line([(46,78),(46,160),(80,160),(80,113),(112,113),(112,160),(146,160),(146,78)],fill=color,width=width,joint='curve')
        elif name=='car':
            d.rounded_rectangle((24,79,168,138),radius=14,outline=color,width=width)
            d.line([(41,80),(59,43),(133,43),(151,80)],fill=color,width=width,joint='curve')
            d.line([(45,140),(45,159)],fill=color,width=width);d.line([(147,140),(147,159)],fill=color,width=width)
            d.line([(42,104),(60,104)],fill=color,width=width);d.line([(132,104),(150,104)],fill=color,width=width)
        elif name=='key':
            d.ellipse((30,25,114,109),outline=color,width=width)
            d.line([(100,99),(157,156),(174,139),(159,124),(145,138)],fill=color,width=width,joint='curve')
        else:
            d.ellipse((61,26,131,96),outline=color,width=width)
            d.arc((30,106,162,205),180,360,fill=color,width=width)
        im.resize((48,48),Image.Resampling.LANCZOS).save(DEST/f'{name}{"-active" if active else ""}.png',optimize=True)
print('12 original PNG assets created')
